import { Hono } from "hono";
import type { Context } from "hono";
import fs from "node:fs";
import path from "node:path";
import { z, ZodError } from "zod";
import type { AuthService } from "./auth.js";
import type { FileOutbox } from "./outbox.js";
import { listDrivers } from "./agents/index.js";
import { listProfiles } from "./profiles.js";
import type { PushClient } from "./push-client.js";
import { ConflictError, NotFoundError, SessionManager, ValidationError } from "./session-manager.js";
import { TINY_VERSION } from "./version.js";
import type { Stores } from "./stores.js";
import type { SessionRecord, SessionResponse, SessionStatus } from "./types.js";
import { UsageError, type UsageService } from "./usage.js";
import { isOnPath } from "./which.js";

export interface ApiDeps {
  manager: SessionManager;
  auth: AuthService;
  outbox: FileOutbox;
  profilesDir: string;
  stores: Stores;
  serverUrl: () => string;
  push: PushClient;
  usage: UsageService;
  /** Whether the agent's own CLI still holds a session. null = cannot tell */
  isCliLive: (s: SessionRecord) => boolean | null;
}

// The set of valid permissionMode / effort values is per-agent (driver capabilities),
// so only the shape is checked here; SessionManager matches values against the profile's options (mismatch is 400)
const createSessionSchema = z.object({
  profile: z.string(),
  cwd: z.string(),
  permissionMode: z.string().min(1).max(50).optional(),
  model: z.string().min(1).max(100).optional(),
  effort: z.string().min(1).max(50).optional(),
});
const sessionPatchSchema = z.object({
  model: z.string().min(1).max(100).nullable().optional(),
  effort: z.string().min(1).max(50).nullable().optional(),
  permissionMode: z.string().min(1).max(50).optional(),
  title: z.string().min(1).max(200).optional(),
  archived: z.boolean().optional(),
});
const turnSchema = z.object({
  prompt: z.string().min(1),
  // base64. ~7.5MB per image (10M chars in base64), max 4 images
  images: z
    .array(
      z.object({
        data: z.string().min(1).max(10_000_000),
        mediaType: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]),
      }),
    )
    .max(4)
    .optional(),
});
const detachSchema = z.object({ detached: z.boolean() });
const adoptSessionSchema = z.object({
  agent: z.string().min(1).max(50).optional(),
  profile: z.string(),
  cwd: z.string(),
  agentSessionId: z.string().min(1).max(200),
  permissionMode: z.string().min(1).max(50).optional(),
  model: z.string().min(1).max(100).optional(),
  effort: z.string().min(1).max(50).optional(),
});
const discardEmptySchema = z.object({ agentSessionId: z.string().min(1).max(200) });
// `tiny mcp-server` → tinyd. Absolute paths only (the MCP server's cwd differs from the agent's)
const userFileSchema = z.object({
  path: z.string().min(1),
  caption: z.string().max(1000).optional(),
});
const permissionSchema = z.discriminatedUnion("behavior", [
  // updatedInput: writes e.g. AskUserQuestion answers back into the tool input (optional)
  z.object({ behavior: z.literal("allow"), updatedInput: z.record(z.unknown()).optional() }),
  z.object({ behavior: z.literal("deny"), message: z.string().default("denied") }),
]);
const deviceSchema = z.object({ code: z.string(), name: z.string().min(1) });
const apnsSchema = z.object({
  apnsToken: z.string().min(1),
  apnsEnv: z.enum(["production", "sandbox"]).default("production"),
});

export function bearerFrom(authHeader: string | undefined, tokenQuery: string | undefined): string {
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
  return tokenQuery ?? "";
}

/** Authenticated principal set by middleware. Used for per-route authorization. */
type AppEnv = { Variables: { principal: "cli" | "device" | "session"; sessionScope?: string } };
type HonoContext = Context<AppEnv>;

export function createApp(deps: ApiDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const withLive = (s: SessionRecord): SessionResponse => ({
    ...s,
    cliLive: deps.isCliLive(s),
    cliJoin: deps.manager.canJoin(s),
    activity: deps.manager.activity(s),
  });

  app.onError((err, c) => {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ConflictError) return c.json({ error: err.message }, 409);
    // Usage has no numbers to show: say what is wrong in one line, how to fix it, and keep the raw
    // upstream text in `detail` for the app's Details disclosure
    if (err instanceof UsageError) {
      return c.json({ error: err.message, problem: err.problem, hint: err.hint, detail: err.detail }, err.status);
    }
    if (err instanceof ZodError || err instanceof SyntaxError) return c.json({ error: err.message }, 400);
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    return c.json({ error: err.message }, 500);
  });

  // version: lets the app detect an outdated tinyd (package.json is the source of truth)
  app.get("/v1/health", (c) => c.json({ ok: true, version: TINY_VERSION }));

  app.post("/v1/devices", async (c) => {
    const body = deviceSchema.parse(await c.req.json());
    const dev = deps.auth.redeemPairing(body.code, body.name);
    if (!dev) return c.json({ error: "invalid or expired code" }, 403);
    return c.json(dev, 201);
  });

  // Everything below requires a Bearer token.
  // WebSocket upgrade requests are authenticated separately in ws.ts, which returns close(4401) when unauthenticated.
  // Limit the bypass to the stream path (do not let header spoofing skip auth on other routes).
  app.use("/v1/*", async (c, next) => {
    const isWsUpgrade = c.req.header("upgrade")?.toLowerCase() === "websocket";
    if (isWsUpgrade && /^\/v1\/sessions\/[^/]+\/stream$/.test(c.req.path)) return next();
    const token = bearerFrom(c.req.header("Authorization"), c.req.query("token"));
    const who = deps.auth.resolve(token);
    if (who === null) return c.json({ error: "unauthorized" }, 401);
    c.set("principal", who.kind);
    if (who.kind === "session") {
      // A session token (tiny mcp-server) may only POST /files to its own session
      c.set("sessionScope", who.sessionId);
      const m = /^\/v1\/sessions\/([^/]+)\/files$/.exec(c.req.path);
      if (c.req.method !== "POST" || !m || m[1] !== who.sessionId) {
        return c.json({ error: "forbidden (session token can only post files to its own session)" }, 403);
      }
    }
    await next();
  });

  // Admin routes (pairing issuance, device revocation, push test) are allowed only for the CLI token on the Mac.
  // Without this, a single device token from a stolen iPhone could pair additional devices
  // (impossible to lock out) and revoke every device.
  const requireCli = (c: HonoContext): Response | null =>
    c.get("principal") === "cli" ? null : c.json({ error: "forbidden (CLI only)" }, 403);

  // For /files: cli passes as before; session passes (middleware already verified it matches its own session); device is 403
  const requireCliOrOwnSession = (c: HonoContext): Response | null =>
    c.get("principal") === "cli" || c.get("principal") === "session" ? null : c.json({ error: "forbidden (CLI only)" }, 403);

  app.get("/v1/profiles", (c) => c.json({ profiles: listProfiles(deps.profilesDir) }));

  // Registered agents (driver definitions). installed = whether the executable is on PATH
  app.get("/v1/agents", (c) =>
    c.json({
      agents: listDrivers().map((d) => ({ id: d.id, label: d.label, bin: d.bin, installed: isOnPath(d.bin) })),
    }));

  // Equivalent of Claude Code's /usage (session/weekly usage percent and reset time). Cached for 60 seconds
  app.get("/v1/profiles/:name/usage", async (c) => {
    return c.json(await deps.usage.get(c.req.param("name")));
  });

  app.get("/v1/sessions", (c) => {
    const status = c.req.query("status") as SessionStatus | undefined;
    const archived = c.req.query("archived") === "true";
    return c.json({ sessions: deps.manager.listSessions(status, archived).map(withLive) });
  });

  // Working-directory candidates for New Session (includes cwds of archived sessions; only ones that still exist)
  app.get("/v1/cwds", (c) => c.json({ cwds: deps.manager.listRecentCwds() }));

  app.post("/v1/sessions", async (c) => {
    const body = createSessionSchema.parse(await c.req.json());
    // `tiny new` on the Mac is announced to the phone; the phone creating one is not
    const announce = c.get("principal") === "cli";
    return c.json(withLive(deps.manager.createSession(body, { announce })), 201);
  });

  // `tiny handoff`: register a session started in the agent's own CLI. Idempotent (SessionStart
  // hooks fire again on resume / fork / clear), so an existing session comes back as 200
  app.post("/v1/sessions/adopt", async (c) => {
    const body = adoptSessionSchema.parse(await c.req.json());
    const { session, adopted } = deps.manager.adoptSession(body);
    return c.json(withLive(session), adopted ? 201 : 200);
  });

  // SessionEnd path: drop a handoff session that never got a single event
  app.post("/v1/sessions/discard-empty", async (c) => {
    const body = discardEmptySchema.parse(await c.req.json());
    return c.json({ discarded: deps.manager.discardIfEmpty(body.agentSessionId) });
  });

  app.get("/v1/sessions/:id", (c) => c.json(withLive(deps.manager.getSession(c.req.param("id")))));

  app.get("/v1/sessions/:id/events", (c) => {
    const id = c.req.param("id");
    const since = Number(c.req.query("since") ?? 0);
    // Catch up with what the agent's own CLI wrote. Unconditional: the CLI writes to the transcript
    // whether or not it still holds the session, and a stat guard inside syncTranscript makes the
    // unchanged case a single stat. Never from the list endpoint (that polls every 4s across every row)
    deps.manager.syncTranscript(id);
    return c.json({ events: deps.stores.events.listSince(id, Number.isFinite(since) ? since : 0) });
  });

  app.patch("/v1/sessions/:id", async (c) => {
    const d = sessionPatchSchema.parse(await c.req.json());
    return c.json(deps.manager.updateSession(c.req.param("id"), d));
  });

  app.post("/v1/sessions/:id/turns", async (c) => {
    const body = turnSchema.parse(await c.req.json());
    deps.manager.startTurn(c.req.param("id"), body.prompt, body.images);
    return c.json({ ok: true }, 202);
  });

  app.post("/v1/sessions/:id/interrupt", async (c) => {
    await deps.manager.interrupt(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/v1/sessions/:id/detach", async (c) => {
    const body = detachSchema.parse(await c.req.json());
    return c.json(deps.manager.setDetached(c.req.param("id"), body.detached));
  });

  // File delivery from the agent's MCP (`tiny mcp-server`). CLI token or the session's own session token only
  app.post("/v1/sessions/:id/files", async (c) => {
    const forbidden = requireCliOrOwnSession(c);
    if (forbidden) return forbidden;
    const body = userFileSchema.parse(await c.req.json());
    if (!path.isAbsolute(body.path)) return c.json({ error: `path must be absolute: ${body.path}` }, 400);
    if (!fs.existsSync(body.path)) return c.json({ error: `file not found: ${body.path}` }, 404);
    const rec = deps.manager.saveUserFile(c.req.param("id"), body.path, body.caption);
    return c.json({ fileId: rec.id, mime: rec.mime }, 201);
  });

  app.get("/v1/sessions/:id/permissions", (c) =>
    c.json({ pending: deps.manager.listPendingPermissions(c.req.param("id")) }));

  app.post("/v1/permissions/:reqId", async (c) => {
    const d = permissionSchema.parse(await c.req.json());
    const ok = deps.manager.resolvePermission(
      c.req.param("reqId"),
      d.behavior === "allow"
        ? { behavior: "allow", ...(d.updatedInput ? { updatedInput: d.updatedInput } : {}) }
        : { behavior: "deny", message: d.message },
    );
    if (!ok) return c.json({ error: "permission request not found" }, 404);
    return c.json({ ok: true });
  });

  app.get("/v1/files/:fileId", (c) => {
    const rec = deps.outbox.get(c.req.param("fileId"));
    if (!rec || !fs.existsSync(rec.storedPath)) return c.json({ error: "file not found" }, 404);
    const data = fs.readFileSync(rec.storedPath);
    // Never interpreted as a type other than declared (nosniff). Defense that closes the path of
    // mis-executing generated HTML/SVG under a different MIME. Inline HTML rendering itself is the WebView's call
    return c.newResponse(data, 200, {
      "Content-Type": rec.mime,
      "X-Content-Type-Options": "nosniff",
    });
  });

  app.post("/v1/pair/start", (c) => {
    const denied = requireCli(c);
    if (denied) return denied;
    const { code, expiresAt } = deps.auth.createPairingCode();
    return c.json({ code, expiresAt, url: deps.serverUrl() });
  });

  // Secrets (bearerToken / e2eKey) are never returned. Used by the CLI's `tiny devices`.
  app.get("/v1/devices", (c) => {
    const denied = requireCli(c);
    if (denied) return denied;
    return c.json({
      devices: deps.stores.devices.list().map((d) => ({
        id: d.id,
        name: d.name,
        hasApnsToken: d.apnsToken !== null,
        apnsEnv: d.apnsEnv,
        createdAt: d.createdAt,
      })),
    });
  });

  // Device revocation (`tiny devices revoke`). Deletes the whole row, so the bearer token is invalidated immediately.
  app.delete("/v1/devices/:id", (c) => {
    const denied = requireCli(c);
    if (denied) return denied;
    if (!deps.stores.devices.delete(c.req.param("id"))) {
      return c.json({ error: "device not found" }, 404);
    }
    return c.json({ ok: true });
  });

  // Allows verifying the tinyd → relay → APNs path even before the real device app exists.
  // Broadcasts to all devices, so CLI token only (devices cannot call this).
  app.post("/v1/push/test", async (c) => {
    const denied = requireCli(c);
    if (denied) return denied;
    return c.json({
      results: await deps.push.deliver({
        v: 1,
        type: "turn_completed",
        sessionId: "push-test",
        eventId: 0,
        title: "tiny",
        body: "Test notification (tiny push test)",
        category: "tiny.info",
        level: "active",
      }),
    });
  });

  app.patch("/v1/devices/me", async (c) => {
    const body = apnsSchema.parse(await c.req.json());
    const token = bearerFrom(c.req.header("Authorization"), c.req.query("token"));
    if (!deps.auth.setApnsToken(token, body.apnsToken, body.apnsEnv)) {
      return c.json({ error: "not a device token" }, 404);
    }
    return c.json({ ok: true });
  });

  return app;
}
