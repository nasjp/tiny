import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db.js";
import { createStores, type Stores } from "../src/stores.js";
import { addProfile } from "../src/profiles.js";
import { PermissionBroker } from "../src/permission-broker.js";
import { FileOutbox } from "../src/outbox.js";
import { SessionManager } from "../src/session-manager.js";
import { AuthService } from "../src/auth.js";
import { createApp } from "../src/api.js";
import type { AgentAdapter } from "../src/adapter.js";
import { PushClient } from "../src/push-client.js";
import { UsageService } from "../src/usage.js";

// Condensed rate_limits from the SDK's usage response (the limits array is what /usage actually shows)
const usageFixture = {
  limits: [
    { kind: "session", group: "session", percent: 42, severity: "normal", resets_at: "2026-08-27T09:09:59Z", scope: null },
    { kind: "weekly_all", group: "weekly", percent: 7, severity: "normal", resets_at: "2026-09-03T01:59:59Z", scope: null },
    { kind: "weekly_scoped", group: "weekly", percent: 3, severity: "normal", resets_at: "2026-09-03T01:59:59Z", scope: { model: { id: null, display_name: "Fable" } } },
  ],
};

const okAdapter: AgentAdapter = {
  async runTurn(p) {
    p.emit({ type: "turn_started", payload: {} });
    p.emit({ type: "turn_completed", payload: {} });
    return { agentSessionId: "agent-1", costUsd: null, resultText: "ok" };
  },
};

describe("REST API", () => {
  let app: ReturnType<typeof createApp>;
  let token: string;
  let manager: SessionManager;
  let stores: Stores;
  let outbox: FileOutbox;
  let cwd: string;
  let usage: UsageService;
  let auth: AuthService;
  let profilesDir: string;
  let cliLive: boolean | null = null;

  beforeEach(() => {
    cliLive = null;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-api-"));
    profilesDir = path.join(home, "profiles");
    addProfile(profilesDir, "work");
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-api-cwd-"));
    stores = createStores(openDb(":memory:"));
    outbox = new FileOutbox(fs.mkdtempSync(path.join(os.tmpdir(), "tiny-api-ob-")), stores.files);
    // Same resolver for the manager and for createApp, exactly as startServer() wires it
    const isCliLive = () => cliLive;
    manager = new SessionManager({
      stores, profilesDir, adapters: { claude: okAdapter }, broker: new PermissionBroker(1000), outbox,
      isCliLive,
    });
    auth = new AuthService(stores, path.join(home, "secret"));
    token = auth.cliToken();
    const push = new PushClient({
      stores,
      settings: () => ({ relayUrl: "https://relay.test", pushEnabled: true, serverUrl: "" }),
      fetchImpl: (async () =>
        new Response(JSON.stringify({ ok: true, status: 200, apnsId: "ID" }), { status: 200 })) as unknown as typeof fetch,
    });
    usage = new UsageService(profilesDir, { fetcher: async () => usageFixture, isLoggedIn: () => true });
    app = createApp({
      manager, auth, outbox, profilesDir, stores,
      serverUrl: () => "http://mac:7777", push, usage,
      isCliLive,
    });
  });

  const H = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

  it("health needs no auth, everything else is 401", async () => {
    expect((await app.request("/v1/health")).status).toBe(200);
    expect((await app.request("/v1/sessions")).status).toBe(401);
    expect((await app.request("/v1/sessions?token=" + token)).status).toBe(200);
  });

  it("spoofed Upgrade header without a token is still 401", async () => {
    const res = await app.request("/v1/sessions", {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(401);
  });

  it("profiles / sessions CRUD / turns / detach / events", async () => {
    const profiles = await (await app.request("/v1/profiles", { headers: H() })).json();
    expect(profiles.profiles[0].name).toBe("work");

    const created = await app.request("/v1/sessions", {
      method: "POST", headers: H(),
      body: JSON.stringify({ profile: "work", cwd, permissionMode: "acceptEdits" }),
    });
    expect(created.status).toBe(201);
    const sess = await created.json();

    const badCwd = await app.request("/v1/sessions", {
      method: "POST", headers: H(), body: JSON.stringify({ profile: "work", cwd: "/no/such" }),
    });
    expect(badCwd.status).toBe(404);

    const turn = await app.request(`/v1/sessions/${sess.id}/turns`, {
      method: "POST", headers: H(), body: JSON.stringify({ prompt: "hey" }),
    });
    expect(turn.status).toBe(202);
    await manager.waitForIdle(sess.id);

    const events = await (await app.request(`/v1/sessions/${sess.id}/events?since=0`, { headers: H() })).json();
    expect(events.events.map((e: { type: string }) => e.type)).toEqual([
      "user_message",
      "turn_started",
      "turn_completed",
    ]);

    const detached = await app.request(`/v1/sessions/${sess.id}/detach`, {
      method: "POST", headers: H(), body: JSON.stringify({ detached: true }),
    });
    expect((await detached.json()).status).toBe("detached");
    const conflict = await app.request(`/v1/sessions/${sess.id}/turns`, {
      method: "POST", headers: H(), body: JSON.stringify({ prompt: "x" }),
    });
    expect(conflict.status).toBe(409);
    expect((await app.request("/v1/sessions/missing", { headers: H() })).status).toBe(404);
  });

  it("PATCH /v1/sessions/:id changes model and permission mode mid-session", async () => {
    const created = await (
      await app.request("/v1/sessions", {
        method: "POST", headers: H(), body: JSON.stringify({ profile: "work", cwd }),
      })
    ).json();
    const patched = await (
      await app.request(`/v1/sessions/${created.id}`, {
        method: "PATCH", headers: H(),
        body: JSON.stringify({ model: "claude-opus-5", permissionMode: "acceptEdits", effort: "xhigh", title: "renamed" }),
      })
    ).json();
    expect(patched.model).toBe("claude-opus-5");
    expect(patched.permissionMode).toBe("acceptEdits");
    expect(patched.effort).toBe("xhigh");
    expect(patched.title).toBe("renamed");
    // model can be cleared with null (reverts to the CLI default)
    const cleared = await (
      await app.request(`/v1/sessions/${created.id}`, {
        method: "PATCH", headers: H(), body: JSON.stringify({ model: null }),
      })
    ).json();
    expect(cleared.model).toBeNull();
    expect(cleared.permissionMode).toBe("acceptEdits");
    // unknown session is 404, invalid value is 400
    expect(
      (await app.request("/v1/sessions/missing", {
        method: "PATCH", headers: H(), body: JSON.stringify({ model: "x" }),
      })).status,
    ).toBe(404);
    expect(
      (await app.request(`/v1/sessions/${created.id}`, {
        method: "PATCH", headers: H(), body: JSON.stringify({ permissionMode: "typo" }),
      })).status,
    ).toBe(400);
  });

  it("invalid body is 400", async () => {
    const res = await app.request("/v1/sessions", {
      method: "POST", headers: H(), body: JSON.stringify({ profile: "work", cwd, permissionMode: "typo" }),
    });
    expect(res.status).toBe(400);
    const broken = await app.request("/v1/sessions", { method: "POST", headers: H(), body: "{not json" });
    expect(broken.status).toBe(400);
  });

  it("GET /v1/profiles/:name/usage returns normalized usage", async () => {
    const res = await app.request("/v1/profiles/work/usage", { headers: H() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile).toBe("work");
    expect(body.limits).toEqual([
      { kind: "session", label: "Session (5h)", percent: 42, resetsAt: "2026-08-27T09:09:59Z" },
      { kind: "weekly_all", label: "Weekly (all models)", percent: 7, resetsAt: "2026-09-03T01:59:59Z" },
      { kind: "weekly_scoped", label: "Weekly (Fable)", percent: 3, resetsAt: "2026-09-03T01:59:59Z" },
    ]);
    // nonexistent profile is 500 (existing behavior: profileDir throws a plain Error)
    expect((await app.request("/v1/profiles/nope/usage", { headers: H() })).status).toBe(500);
  });

  it("permissions: unknown reqId is 404", async () => {
    // Pending creation-to-resolution integration is covered by the Task 7 tests. The API layer only checks the 404 response.
    const notFound = await app.request(`/v1/permissions/nope`, {
      method: "POST", headers: H(), body: JSON.stringify({ behavior: "allow" }),
    });
    expect(notFound.status).toBe(404);
    // updatedInput (AskUserQuestion answers) is accepted by the schema (reaches 404 instead of failing with 400)
    const withInput = await app.request(`/v1/permissions/nope`, {
      method: "POST", headers: H(),
      body: JSON.stringify({ behavior: "allow", updatedInput: { answers: { Q: "A" } } }),
    });
    expect(withInput.status).toBe(404);
  });

  it("files: serves an outbox file with its MIME type", async () => {
    const src = path.join(cwd, "r.html");
    fs.writeFileSync(src, "<p>ok</p>");
    const rec = outbox.save("s1", src);
    const res = await app.request(`/v1/files/${rec.id}`, { headers: H() });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe("<p>ok</p>");
    expect((await app.request(`/v1/files/none`, { headers: H() })).status).toBe(404);
  });

  it("pair/start, then device registration, then the new token authenticates", async () => {
    const started = await (await app.request("/v1/pair/start", { method: "POST", headers: H() })).json();
    expect(started.url).toBe("http://mac:7777");
    const redeemed = await app.request("/v1/devices", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: started.code, name: "iPhone" }),
    });
    expect(redeemed.status).toBe(201);
    const dev = await redeemed.json();
    const ok = await app.request("/v1/sessions", { headers: { Authorization: `Bearer ${dev.bearerToken}` } });
    expect(ok.status).toBe(200);
    const patched = await app.request("/v1/devices/me", {
      method: "PATCH", headers: { Authorization: `Bearer ${dev.bearerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ apnsToken: "apns-xyz" }),
    });
    expect(patched.status).toBe(200);
    const bad = await app.request("/v1/devices", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "WRONGCOD", name: "x" }),
    });
    expect(bad.status).toBe(403);
  });

  it("admin routes (pair/start, devices, push test) are 403 with a device token (CLI only)", async () => {
    // First register one device using the CLI token
    const { code } = (await (await app.request("/v1/pair/start", { method: "POST", headers: H() })).json()) as { code: string };
    const dev = (await (await app.request("/v1/devices", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, name: "iPhone" }),
    })).json()) as { deviceId: string; bearerToken: string };
    const D = { Authorization: `Bearer ${dev.bearerToken}`, "Content-Type": "application/json" };

    // Normal operations still work with a device token
    expect((await app.request("/v1/sessions", { headers: D })).status).toBe(200);
    // All admin routes are 403
    expect((await app.request("/v1/pair/start", { method: "POST", headers: D })).status).toBe(403);
    expect((await app.request("/v1/devices", { headers: D })).status).toBe(403);
    expect((await app.request(`/v1/devices/${dev.deviceId}`, { method: "DELETE", headers: D })).status).toBe(403);
    expect((await app.request("/v1/push/test", { method: "POST", headers: D })).status).toBe(403);
    // The device was not revoked (stopped by the 403)
    const listed = (await (await app.request("/v1/devices", { headers: H() })).json()) as { devices: unknown[] };
    expect(listed.devices).toHaveLength(1);
  });

  it("DELETE /v1/devices/:id revokes the device (its token gets 401 afterwards)", async () => {
    const { code } = (await (await app.request("/v1/pair/start", { method: "POST", headers: H() })).json()) as { code: string };
    const dev = (await (await app.request("/v1/devices", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, name: "old iPhone" }),
    })).json()) as { deviceId: string; bearerToken: string };

    const res = await app.request(`/v1/devices/${dev.deviceId}`, { method: "DELETE", headers: H() });
    expect(res.status).toBe(200);
    // Gone from the list, and access with the revoked token is 401
    const list = (await (await app.request("/v1/devices", { headers: H() })).json()) as { devices: { id: string }[] };
    expect(list.devices.some((d) => d.id === dev.deviceId)).toBe(false);
    const revoked = await app.request("/v1/sessions", { headers: { Authorization: `Bearer ${dev.bearerToken}` } });
    expect(revoked.status).toBe(401);
    // nonexistent id is 404
    expect((await app.request("/v1/devices/nope", { method: "DELETE", headers: H() })).status).toBe(404);
  });

  it("pairing, then APNs token registration, then the device list stays consistent", async () => {
    const { code } = (await (await app.request("/v1/pair/start", { method: "POST", headers: H() })).json()) as { code: string };
    const dev = (await (await app.request("/v1/devices", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, name: "iPhone" }),
    })).json()) as { deviceId: string; bearerToken: string; e2eKey: string };

    expect(Buffer.from(dev.e2eKey, "base64")).toHaveLength(32);

    const patched = await app.request("/v1/devices/me", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${dev.bearerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ apnsToken: "c".repeat(64), apnsEnv: "sandbox" }),
    });
    expect(patched.status).toBe(200);

    const listed = (await (await app.request("/v1/devices", { headers: H() })).json()) as {
      devices: Array<{ id: string; name: string; hasApnsToken: boolean; apnsEnv: string }>;
    };
    expect(listed.devices).toHaveLength(1);
    expect(listed.devices[0]).toMatchObject({ id: dev.deviceId, name: "iPhone", hasApnsToken: true, apnsEnv: "sandbox" });
  });

  it("device list does not leak bearerToken or e2eKey", async () => {
    const { code } = (await (await app.request("/v1/pair/start", { method: "POST", headers: H() })).json()) as { code: string };
    await app.request("/v1/devices", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, name: "iPhone" }),
    });
    const text = await (await app.request("/v1/devices", { headers: H() })).text();
    expect(text).not.toMatch(/bearerToken|e2eKey/);
  });

  it("apnsEnv defaults to production when omitted", async () => {
    const { code } = (await (await app.request("/v1/pair/start", { method: "POST", headers: H() })).json()) as { code: string };
    const dev = (await (await app.request("/v1/devices", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, name: "iPad" }),
    })).json()) as { bearerToken: string };
    await app.request("/v1/devices/me", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${dev.bearerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ apnsToken: "d".repeat(64) }),
    });
    const listed = (await (await app.request("/v1/devices", { headers: H() })).json()) as {
      devices: Array<{ apnsEnv: string }>;
    };
    expect(listed.devices[0]?.apnsEnv).toBe("production");
  });

  it("POST /v1/push/test returns per-device delivery results", async () => {
    const { code } = (await (await app.request("/v1/pair/start", { method: "POST", headers: H() })).json()) as { code: string };
    const dev = (await (await app.request("/v1/devices", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, name: "iPhone" }),
    })).json()) as { bearerToken: string };
    await app.request("/v1/devices/me", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${dev.bearerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ apnsToken: "e".repeat(64), apnsEnv: "sandbox" }),
    });

    const res = await app.request("/v1/push/test", { method: "POST", headers: H() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ ok?: boolean }> };
    expect(body.results).toHaveLength(1);
  });

  it("POST /v1/push/test requires auth", async () => {
    expect((await app.request("/v1/push/test", { method: "POST" })).status).toBe(401);
  });

  it("archive: PATCH archived removes it from the list, shows it in ?archived=true, and can restore it", async () => {
    const created = (await (await app.request("/v1/sessions", {
      method: "POST", headers: H(), body: JSON.stringify({ profile: "work", cwd }),
    })).json()) as { id: string };

    const archived = (await (await app.request(`/v1/sessions/${created.id}`, {
      method: "PATCH", headers: H(), body: JSON.stringify({ archived: true }),
    })).json()) as { archivedAt: string | null };
    expect(archived.archivedAt).toBeTruthy();

    const normal = (await (await app.request("/v1/sessions", { headers: H() })).json()) as { sessions: unknown[] };
    expect(normal.sessions).toHaveLength(0);
    const arch = (await (await app.request("/v1/sessions?archived=true", { headers: H() })).json()) as {
      sessions: Array<{ id: string }>;
    };
    expect(arch.sessions.map((s) => s.id)).toEqual([created.id]);

    // GET /:id, events, and turns still work as before on an archived session
    expect((await app.request(`/v1/sessions/${created.id}`, { headers: H() })).status).toBe(200);
    expect((await app.request(`/v1/sessions/${created.id}/events?since=0`, { headers: H() })).status).toBe(200);
    expect(
      (await app.request(`/v1/sessions/${created.id}/turns`, {
        method: "POST", headers: H(), body: JSON.stringify({ prompt: "hi" }),
      })).status,
    ).toBe(202);
    await manager.waitForIdle(created.id);

    const restored = (await (await app.request(`/v1/sessions/${created.id}`, {
      method: "PATCH", headers: H(), body: JSON.stringify({ archived: false }),
    })).json()) as { archivedAt: string | null };
    expect(restored.archivedAt).toBeNull();
    const after = (await (await app.request("/v1/sessions", { headers: H() })).json()) as { sessions: unknown[] };
    expect(after.sessions).toHaveLength(1);
  });

  it("cwds: GET /v1/cwds returns cwd history newest first, including archived sessions, excluding deleted directories", async () => {
    const gone = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-api-cwd-gone-"));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-api-cwd-other-"));
    const mk = async (dir: string) =>
      (await (await app.request("/v1/sessions", {
        method: "POST", headers: H(), body: JSON.stringify({ profile: "work", cwd: dir }),
      })).json()) as { id: string };
    const a = await mk(cwd);
    await mk(gone);
    await mk(other);
    // Touch a afterwards (updated_at advances) so it moves to the front. It also survives being archived
    await app.request(`/v1/sessions/${a.id}`, {
      method: "PATCH", headers: H(), body: JSON.stringify({ archived: true }),
    });
    fs.rmSync(gone, { recursive: true, force: true });

    expect((await app.request("/v1/cwds")).status).toBe(401);
    const res = await app.request("/v1/cwds", { headers: H() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cwds: string[] };
    // Ordering (most recently used first) is verified in the stores tests. Rows here can share the same ms, so compare as a set
    expect([...body.cwds].sort()).toEqual([cwd, other].sort());
  });

  it("archive: PATCH archived while running / detached is 409", async () => {
    const created = (await (await app.request("/v1/sessions", {
      method: "POST", headers: H(), body: JSON.stringify({ profile: "work", cwd }),
    })).json()) as { id: string };
    stores.sessions.patch(created.id, { status: "running" });
    expect(
      (await app.request(`/v1/sessions/${created.id}`, {
        method: "PATCH", headers: H(), body: JSON.stringify({ archived: true }),
      })).status,
    ).toBe(409);
    stores.sessions.patch(created.id, { status: "detached" });
    expect(
      (await app.request(`/v1/sessions/${created.id}`, {
        method: "PATCH", headers: H(), body: JSON.stringify({ archived: true }),
      })).status,
    ).toBe(409);
  });

  it("GET /v1/profiles returns label and capabilities (the shape the Phase A app reads)", async () => {
    const res = await app.request("/v1/profiles", { headers: H() });
    expect(res.status).toBe(200);
    const { profiles } = await res.json();
    expect(profiles[0].name).toBe("work");
    expect(profiles[0].agent).toBe("claude");
    expect(profiles[0].label).toBe("Claude");
    expect(profiles[0].capabilities.models[0].id).toMatch(/^claude-/);
    expect(profiles[0].capabilities.efforts).toContain("max");
    expect(profiles[0].capabilities.permissionModes.map((m: { id: string }) => m.id)).toEqual(["default", "acceptEdits", "bypassPermissions"]);
    expect(profiles[0].capabilities.features.usage).toBe(true);
  });

  it("GET /v1/agents returns registered drivers", async () => {
    const res = await app.request("/v1/agents", { headers: H() });
    expect(res.status).toBe(200);
    const { agents } = await res.json();
    expect(agents.map((a: { id: string }) => a.id)).toContain("claude");
    expect(agents.find((a: { id: string }) => a.id === "claude").label).toBe("Claude");
    expect(typeof agents[0].installed).toBe("boolean");
  });

  it("permissionMode / effort values absent from profile capabilities are rejected with 400 (no hardcoded enum)", async () => {
    const mk = (body: Record<string, unknown>) =>
      app.request("/v1/sessions", { method: "POST", headers: H(), body: JSON.stringify({ profile: "work", cwd, ...body }) });
    expect((await mk({ permissionMode: "plan" })).status).toBe(400);
    expect((await mk({ effort: "ultra" })).status).toBe(400);
    const ok = await mk({ permissionMode: "acceptEdits", effort: "xhigh" });
    expect(ok.status).toBe(201);
    const s = await ok.json();
    expect(s.permissionMode).toBe("acceptEdits");
    expect(s.agent).toBe("claude");
    // Mid-session changes go through the same validation
    const bad = await app.request(`/v1/sessions/${s.id}`, { method: "PATCH", headers: H(), body: JSON.stringify({ permissionMode: "yolo" }) });
    expect(bad.status).toBe(400);
    const good = await app.request(`/v1/sessions/${s.id}`, { method: "PATCH", headers: H(), body: JSON.stringify({ effort: "low" }) });
    expect(good.status).toBe(200);
  });

  it("GET /v1/health returns version (lets the app detect an outdated tinyd)", async () => {
    const body = await (await app.request("/v1/health")).json();
    expect(body.ok).toBe(true);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("POST /v1/sessions/:id/files is CLI-token only, saves to the outbox, and records file_sent (mcp-server path)", async () => {
    const created = await app.request("/v1/sessions", { method: "POST", headers: H(), body: JSON.stringify({ profile: "work", cwd }) });
    const s = await created.json();
    const src = path.join(cwd, "r.html");
    fs.writeFileSync(src, "<p>x</p>");
    const res = await app.request(`/v1/sessions/${s.id}/files`, {
      method: "POST", headers: H(), body: JSON.stringify({ path: src, caption: "cap" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.mime).toBe("text/html");
    expect(typeof body.fileId).toBe("string");
    const events = await (await app.request(`/v1/sessions/${s.id}/events?since=0`, { headers: H() })).json();
    expect(events.events.map((e: { type: string }) => e.type)).toContain("file_sent");
    // missing file is 404, relative path is 400, device token is 403
    expect((await app.request(`/v1/sessions/${s.id}/files`, { method: "POST", headers: H(), body: JSON.stringify({ path: path.join(cwd, "missing.html") }) })).status).toBe(404);
    expect((await app.request(`/v1/sessions/${s.id}/files`, { method: "POST", headers: H(), body: JSON.stringify({ path: "r.html" }) })).status).toBe(400);
    expect((await app.request(`/v1/sessions/nope/files`, { method: "POST", headers: H(), body: JSON.stringify({ path: src }) })).status).toBe(404);
    const started = await (await app.request("/v1/pair/start", { method: "POST", headers: H() })).json();
    const dev = await app.request("/v1/devices", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: started.code, name: "ph" }) });
    const devTok = (await dev.json()).bearerToken;
    expect((await app.request(`/v1/sessions/${s.id}/files`, { method: "POST",
      headers: { Authorization: `Bearer ${devTok}`, "Content-Type": "application/json" }, body: JSON.stringify({ path: src }) })).status).toBe(403);
  });

  describe("session tokens (for tiny mcp-server)", () => {
    const createSession = async () => {
      const res = await app.request("/v1/sessions", { method: "POST", headers: H(), body: JSON.stringify({ profile: "work", cwd }) });
      return res.json();
    };

    it("only POST /files to its own session is allowed", async () => {
      const s = await createSession();
      const tok = auth.issueSessionToken(s.id);
      const file = path.join(cwd, "r.html");
      fs.writeFileSync(file, "<h1>x</h1>");
      const S = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };
      const ok = await app.request(`/v1/sessions/${s.id}/files`, { method: "POST", headers: S, body: JSON.stringify({ path: file }) });
      expect(ok.status).toBe(201);
      // another session
      const other = await createSession();
      expect((await app.request(`/v1/sessions/${other.id}/files`, { method: "POST", headers: S, body: JSON.stringify({ path: file }) })).status).toBe(403);
      // other routes (reads and admin)
      expect((await app.request(`/v1/sessions/${s.id}`, { headers: S })).status).toBe(403);
      expect((await app.request(`/v1/sessions`, { headers: S })).status).toBe(403);
      expect((await app.request(`/v1/files/anything`, { headers: S })).status).toBe(403);
      expect((await app.request(`/v1/pair/start`, { method: "POST", headers: S })).status).toBe(403);
      // 401 after revocation
      auth.revokeSessionToken(tok);
      expect((await app.request(`/v1/sessions/${s.id}/files`, { method: "POST", headers: S, body: JSON.stringify({ path: file }) })).status).toBe(401);
    });

    it("POST /files with the CLI token still passes, and a device token still gets 403", async () => {
      const s = await createSession();
      const file = path.join(cwd, "r2.html");
      fs.writeFileSync(file, "<h1>x</h1>");
      expect((await app.request(`/v1/sessions/${s.id}/files`, { method: "POST", headers: { ...H() }, body: JSON.stringify({ path: file }) })).status).toBe(201);
      const started = await (await app.request("/v1/pair/start", { method: "POST", headers: H() })).json();
      const dev = await app.request("/v1/devices", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: started.code, name: "ph" }) });
      const devTok = (await dev.json()).bearerToken;
      const D = { Authorization: `Bearer ${devTok}`, "Content-Type": "application/json" };
      expect((await app.request(`/v1/sessions/${s.id}/files`, { method: "POST", headers: D, body: JSON.stringify({ path: file }) })).status).toBe(403);
    });
  });

  it("adopts a CLI session and returns it, idempotently", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-ext-"));
    addProfile(profilesDir, "local", "claude", configDir);
    const body = JSON.stringify({ profile: "local", cwd, agentSessionId: "agent-42" });
    const first = await app.request("/v1/sessions/adopt", { method: "POST", headers: H(), body });
    expect(first.status).toBe(201);
    const s1 = (await first.json()) as { id: string; agentSessionId: string };
    expect(s1.agentSessionId).toBe("agent-42");

    const second = await app.request("/v1/sessions/adopt", { method: "POST", headers: H(), body });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { id: string }).id).toBe(s1.id);
  });

  it("rejects adopt without agentSessionId", async () => {
    const res = await app.request("/v1/sessions/adopt", {
      method: "POST", headers: H(), body: JSON.stringify({ profile: "work", cwd }),
    });
    expect(res.status).toBe(400);
  });

  it("discards an adopted session that has no events", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-ext-"));
    addProfile(profilesDir, "local2", "claude", configDir);
    await app.request("/v1/sessions/adopt", {
      method: "POST", headers: H(),
      body: JSON.stringify({ profile: "local2", cwd, agentSessionId: "agent-empty" }),
    });
    const res = await app.request("/v1/sessions/discard-empty", {
      method: "POST", headers: H(), body: JSON.stringify({ agentSessionId: "agent-empty" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ discarded: true });
  });

  // The guard lives in SessionManager, so it only works if the daemon hands the SAME resolver to
  // the manager and to createApp. Exercised over HTTP because that is the path that regressed
  it("refuses a turn while the agent's own CLI holds the session, and allows it otherwise", async () => {
    const created = await app.request("/v1/sessions", {
      method: "POST", headers: H(), body: JSON.stringify({ profile: "work", cwd }),
    });
    const { id } = (await created.json()) as { id: string };

    cliLive = true;
    const blocked = await app.request(`/v1/sessions/${id}/turns`, {
      method: "POST", headers: H(), body: JSON.stringify({ prompt: "hi" }),
    });
    expect(blocked.status).toBe(409);

    cliLive = null;
    const ok = await app.request(`/v1/sessions/${id}/turns`, {
      method: "POST", headers: H(), body: JSON.stringify({ prompt: "hi" }),
    });
    expect(ok.status).toBe(202);
    await manager.waitForIdle(id);
  });

  // The CLI writes to the transcript whether or not it still holds the session, so gating the
  // catch-up on liveness froze the phone's history at adopt time
  it("imports what the CLI wrote even after the CLI is gone", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-ext-"));
    addProfile(profilesDir, "local3", "claude", configDir);
    const res = await app.request("/v1/sessions/adopt", {
      method: "POST", headers: H(),
      body: JSON.stringify({ profile: "local3", cwd, agentSessionId: "agent-late" }),
    });
    const { id } = (await res.json()) as { id: string };

    // the CLI kept going after the adopt, then exited: cliLive is false
    const file = path.join(configDir, "projects", cwd.replace(/[/.]/g, "-"), "agent-late.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "typed in the terminal" } }) + "\n");
    cliLive = false;

    const evs = await app.request(`/v1/sessions/${id}/events`, { headers: H() });
    const { events } = (await evs.json()) as { events: Array<{ type: string; payload: { text?: string } }> };
    expect(events.map((e) => e.type)).toEqual(["user_message"]);
    expect(events[0]!.payload.text).toBe("typed in the terminal");
    cliLive = null;
  });

  // list / get / adopt all carry cliLive; create used to be the one shape that did not
  it("returns cliLive on a freshly created session too", async () => {
    cliLive = false;
    const res = await app.request("/v1/sessions", {
      method: "POST", headers: H(), body: JSON.stringify({ profile: "work", cwd }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()) as { cliLive: boolean | null }).toHaveProperty("cliLive", false);
    cliLive = null;
  });

  it("reports cliLive on the list and on a single session", async () => {
    await app.request("/v1/sessions", { method: "POST", headers: H(), body: JSON.stringify({ profile: "work", cwd }) });
    const res0 = await app.request("/v1/sessions", { headers: H() });
    const { sessions } = (await res0.json()) as { sessions: Array<{ id: string; cliLive: boolean | null }> };
    expect(sessions[0]!.cliLive).toBeNull();

    cliLive = true;
    const res1 = await app.request(`/v1/sessions/${sessions[0]!.id}`, { headers: H() });
    expect(((await res1.json()) as { cliLive: boolean | null }).cliLive).toBe(true);
    cliLive = null;
  });
});
