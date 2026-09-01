import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it } from "vitest";
import { openSealed } from "../src/crypto.js";
import { openDb } from "../src/db.js";
import { buildIntent, buildSessionAddedIntent, collapseIdFor, PushClient, truncate } from "../src/push-client.js";
import { createStores, type Stores } from "../src/stores.js";
import type { DeviceRecord, EventRecord, SessionRecord } from "../src/types.js";

const session = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  id: "sess-1", agentSessionId: "agent-1", agent: "claude", profile: "work",
  cwd: "/Users/me/src/my-repo", permissionMode: "default", model: null, effort: null, title: null, status: "idle", archivedAt: null, sourceCursor: null,
  createdAt: "2026-08-27T00:00:00.000Z", updatedAt: "2026-08-27T00:00:00.000Z", ...over,
});

const event = (type: string, payload: Record<string, unknown> = {}): EventRecord => ({
  id: 42, sessionId: "sess-1", type, payload, createdAt: "2026-08-27T00:00:00.000Z",
});

describe("truncate", () => {
  it("keeps strings at or under the limit", () => expect(truncate("abc", 10)).toBe("abc"));
  it("trims over-limit strings with an ellipsis", () => expect(truncate("abcdef", 4)).toBe("abc…"));
  it("collapses runs of whitespace and newlines into one space", () => expect(truncate("a\n\n  b", 10)).toBe("a b"));
});

describe("buildIntent", () => {
  it("returns null for non-push events", () => {
    expect(buildIntent(event("assistant_text", { text: "hi" }), session())).toBeNull();
    expect(buildIntent(event("tool_started"), session())).toBeNull();
    expect(buildIntent(event("file_sent"), session())).toBeNull();
  });

  it("makes permission_requested time-sensitive and carries reqId", () => {
    const i = buildIntent(event("permission_requested", { reqId: "req-9", toolName: "Bash" }), session())!;
    expect(i).toMatchObject({
      v: 1, type: "permission_requested", sessionId: "sess-1", eventId: 42,
      category: "tiny.permission", level: "time-sensitive", reqId: "req-9",
    });
    expect(i.body).toContain("Bash");
  });

  it("notifies a question the CLI itself asked, with the question category", () => {
    const intent = buildIntent(
      event("cli_question", {
        toolUseId: "tu-1",
        input: { questions: [{ question: "Which goal?", header: "Goal", options: [] }] },
      }),
      null,
    );
    expect(intent!.body).toBe("Claude asks: Which goal?");
    expect(intent!.category).toBe("tiny.question");
    expect(intent!.level).toBe("time-sensitive");
  });

  it("uses the question text as the body for AskUserQuestion", () => {
    const withQ = buildIntent(
      event("permission_requested", {
        reqId: "req-9",
        toolName: "AskUserQuestion",
        input: { questions: [{ question: "Which library should we use?", header: "Library", options: [], multiSelect: false }] },
      }),
      session(),
    )!;
    expect(withQ.body).toBe("Claude asks: Which library should we use?");
    expect(withQ.level).toBe("time-sensitive");
    // Dedicated category with no Allow/Deny actions (tap opens the app to answer)
    expect(withQ.category).toBe("tiny.question");
    // Missing input doesn't crash; falls back to the default wording
    const noInput = buildIntent(
      event("permission_requested", { reqId: "req-9", toolName: "AskUserQuestion" }),
      session(),
    )!;
    expect(noInput.body).toBe("Claude is asking you a question");
  });

  it("uses summary for the permission body when present (shows what it does, not the tool name)", () => {
    const i = buildIntent(
      event("permission_requested", { reqId: "r1", toolName: "Bash", kind: "execute", summary: "rm -rf build", input: { command: "rm -rf build" } }),
      session(),
    )!;
    expect(i.body).toBe("Requesting permission to run: rm -rf build");
    expect(i.category).toBe("tiny.permission");
  });

  it("gives kind=question (the shared shape from other agents) the question category with the first question as the body", () => {
    const i = buildIntent(
      event("permission_requested", {
        reqId: "r2", toolName: "request_user_input", kind: "question", summary: "Which color?",
        input: { questions: [{ text: "Which color?", options: ["Red", "Blue"] }] },
      }),
      session(),
    )!;
    expect(i.category).toBe("tiny.question");
    expect(i.body).toBe("Question: Which color?");
  });

  it("uses the cwd basename for sessions without a title", () => {
    expect(buildIntent(event("permission_requested", { toolName: "Bash" }), session())!.title).toBe("my-repo");
  });

  it("uses the title when present", () => {
    const s = session({ title: "Prepare the release" });
    expect(buildIntent(event("turn_completed"), s)!.title).toBe("Prepare the release");
  });

  it("uses resultText as the body for turn_completed", () => {
    const i = buildIntent(event("turn_completed", { resultText: "The answer is 2", costUsd: 0.01 }), session())!;
    expect(i).toMatchObject({ type: "turn_completed", category: "tiny.info", level: "active" });
    expect(i.body).toBe("The answer is 2");
    expect(i.reqId).toBeUndefined();
  });

  it("falls back to the default wording when turn_completed resultText is empty", () => {
    expect(buildIntent(event("turn_completed", { resultText: "" }), session())!.body).toBe("Turn completed");
  });

  it("trims long turn_completed bodies to 120 characters", () => {
    const i = buildIntent(event("turn_completed", { resultText: "x".repeat(300) }), session())!;
    expect(i.body.length).toBe(120);
  });

  it("builds the turn_failed body from either error or subtype", () => {
    expect(buildIntent(event("turn_failed", { error: "ENOENT" }), session())!.body).toContain("ENOENT");
    expect(buildIntent(event("turn_failed", { subtype: "error_max_turns" }), session())!.body).toContain("error_max_turns");
    expect(buildIntent(event("turn_failed", {}), session())!.body).toContain("unknown");
  });

  it("guides auth_error with the recovery command including the profile name", () => {
    const i = buildIntent(event("auth_error", { error: "not logged in" }), session({ profile: "personal" }))!;
    expect(i.body).toContain("tiny profiles login personal");
  });

  it("still builds an intent when the session is not found", () => {
    expect(buildIntent(event("turn_completed"), null)!.title).toBe("tiny");
  });
});

// A session that shows up from the Mac (a CLI hook, `tiny handoff`, `tiny new`) has no event yet,
// so it is announced from the session record alone
describe("buildSessionAddedIntent", () => {
  it("names the session after its cwd and says where it started", () => {
    const i = buildSessionAddedIntent(session({ title: null, agent: "claude" }), "Claude");
    expect(i).toMatchObject({
      v: 1, type: "session_added", sessionId: "sess-1", eventId: 0, title: "my-repo",
      category: "tiny.info", level: "active",
    });
    expect(i.body).toContain("Claude");
    expect(i.body).toContain("/Users/me/src/my-repo");
    expect(i.reqId).toBeUndefined();
  });

  it("uses the title when the session already has one", () => {
    expect(buildSessionAddedIntent(session({ title: "Handoff design" }), "Claude").title).toBe("Handoff design");
  });
});

describe("collapseIdFor", () => {
  const device: DeviceRecord = {
    id: "dev-1", name: "iPhone", bearerToken: "tok", apnsToken: "t".repeat(64),
    apnsEnv: "sandbox", e2eKey: crypto.randomBytes(32).toString("base64"), createdAt: "2026-08-27T00:00:00.000Z",
  };

  it("always sends a value even for pending permissions, but different events get different values (= APNs replaces nothing)", () => {
    const i1 = buildIntent(event("permission_requested", { toolName: "Bash" }), session())!;
    const i2 = buildIntent({ ...event("permission_requested", { toolName: "Bash" }), id: 43 }, session())!;
    expect(collapseIdFor(i1, device)).toMatch(/^[0-9a-f]{32}$/);
    expect(collapseIdFor(i1, device)).not.toBe(collapseIdFor(i2, device));
  });

  it("collapses completion notifications per session", () => {
    const i = buildIntent(event("turn_completed"), session())!;
    const id = collapseIdFor(i, device);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(collapseIdFor(i, device)).toBe(id);
  });

  it("never exposes the raw session-id (untrackable by the relay; holds for pending permissions too)", () => {
    const completed = buildIntent(event("turn_completed"), session())!;
    expect(collapseIdFor(completed, device)).not.toContain("sess-1");
    const requested = buildIntent(event("permission_requested", { toolName: "Bash" }), session())!;
    expect(collapseIdFor(requested, device)).not.toContain("sess-1");
  });

  it("gives different devices different values (holds for pending permissions too)", () => {
    const completed = buildIntent(event("turn_completed"), session())!;
    const other = { ...device, id: "dev-2", e2eKey: crypto.randomBytes(32).toString("base64") };
    expect(collapseIdFor(completed, other)).not.toBe(collapseIdFor(completed, device));

    const requested = buildIntent(event("permission_requested", { toolName: "Bash" }), session())!;
    expect(collapseIdFor(requested, other)).not.toBe(collapseIdFor(requested, device));
  });
});

describe("PushClient", () => {
  let stores: Stores;
  let calls: Array<{ url: string; body: Record<string, unknown> }>;
  let respond: () => Response;
  let e2eKey: string;

  const settings = { relayUrl: "https://relay.example.com", pushEnabled: true, serverUrl: "" };

  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return respond();
  }) as unknown as typeof fetch;

  const client = () => new PushClient({ stores, settings: () => settings, fetchImpl });

  beforeEach(() => {
    stores = createStores(openDb(":memory:"));
    calls = [];
    respond = () => new Response(JSON.stringify({ ok: true, status: 200, apnsId: "ID" }), { status: 200 });
    settings.relayUrl = "https://relay.example.com";
    settings.pushEnabled = true;
    e2eKey = crypto.randomBytes(32).toString("base64");
    stores.sessions.create(session());
    stores.devices.insert({
      id: "dev-1", name: "iPhone", bearerToken: "tok", apnsToken: "t".repeat(64),
      apnsEnv: "sandbox", e2eKey, createdAt: "2026-08-27T00:00:00.000Z",
    });
  });

  it("POSTs to the relay with a ciphertext the device key can open", async () => {
    await client().handleEvent(event("permission_requested", { reqId: "req-9", toolName: "Bash" }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://relay.example.com/v1/push");
    expect(calls[0]!.body).toMatchObject({ deviceToken: "t".repeat(64), apnsEnv: "sandbox", priority: 10 });

    const opened = JSON.parse(openSealed(e2eKey, String(calls[0]!.body.payload))) as Record<string, unknown>;
    expect(opened).toMatchObject({ v: 1, type: "permission_requested", sessionId: "sess-1", reqId: "req-9" });
  });

  it("passes neither the plaintext type nor the session-id to the relay", async () => {
    await client().handleEvent(event("permission_requested", { reqId: "req-9", toolName: "Bash" }));
    const raw = JSON.stringify(calls[0]!.body);
    expect(raw).not.toContain("permission_requested");
    expect(raw).not.toContain("sess-1");
    expect(raw).not.toContain("Bash");
  });

  it("always includes collapseId in the relay body regardless of type (presence reveals nothing)", async () => {
    await client().handleEvent(event("permission_requested", { reqId: "req-9", toolName: "Bash" }));
    await client().handleEvent(event("turn_completed"));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toHaveProperty("collapseId");
    expect(typeof calls[0]!.body.collapseId).toBe("string");
    expect(calls[1]!.body).toHaveProperty("collapseId");
    expect(typeof calls[1]!.body.collapseId).toBe("string");
  });

  it("passes a timeout signal to fetch", async () => {
    let capturedInit: RequestInit | undefined;
    const client2 = new PushClient({
      stores,
      settings: () => settings,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        capturedInit = init;
        return respond();
      }) as unknown as typeof fetch,
    });
    await client2.handleEvent(event("turn_completed"));
    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it("keeps the token on timeout (a transient relay problem must not revoke it)", async () => {
    const timingOut = new PushClient({
      stores,
      settings: () => settings,
      fetchImpl: (async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      }) as unknown as typeof fetch,
    });
    await expect(timingOut.handleEvent(event("turn_completed"))).resolves.toBeUndefined();
    expect(stores.devices.byId("dev-1")?.apnsToken).toBe("t".repeat(64));
  });

  it("does not double a trailing slash in relayUrl", async () => {
    settings.relayUrl = "https://relay.example.com/";
    await client().handleEvent(event("turn_completed"));
    expect(calls[0]!.url).toBe("https://relay.example.com/v1/push");
  });

  it("pushes a session announced by the manager", async () => {
    const source = new EventEmitter();
    client().attach(source as unknown as Parameters<PushClient["attach"]>[0]);
    source.emit("session_added", session());
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(1);
    const opened = JSON.parse(openSealed(e2eKey, String(calls[0]!.body.payload))) as Record<string, unknown>;
    expect(opened).toMatchObject({ v: 1, type: "session_added", sessionId: "sess-1" });
  });

  it("sends nothing for non-push events", async () => {
    await client().handleEvent(event("assistant_text", { text: "hi" }));
    expect(calls).toHaveLength(0);
  });

  it("sends nothing when relayUrl is empty", async () => {
    settings.relayUrl = "";
    await client().handleEvent(event("turn_completed"));
    expect(calls).toHaveLength(0);
  });

  it("sends nothing when pushEnabled is false", async () => {
    settings.pushEnabled = false;
    await client().handleEvent(event("turn_completed"));
    expect(calls).toHaveLength(0);
  });

  it("sends nothing to devices without a registered APNs token", async () => {
    stores.devices.clearApnsToken("dev-1");
    await client().handleEvent(event("turn_completed"));
    expect(calls).toHaveLength(0);
  });

  it("seals with each device's own key when sending to multiple devices", async () => {
    const key2 = crypto.randomBytes(32).toString("base64");
    stores.devices.insert({
      id: "dev-2", name: "iPad", bearerToken: "tok2", apnsToken: "u".repeat(64),
      apnsEnv: "production", e2eKey: key2, createdAt: "2026-08-27T00:00:01.000Z",
    });
    await client().handleEvent(event("turn_completed", { resultText: "done" }));
    expect(calls).toHaveLength(2);
    expect(JSON.parse(openSealed(e2eKey, String(calls[0]!.body.payload))).type).toBe("turn_completed");
    expect(JSON.parse(openSealed(key2, String(calls[1]!.body.payload))).type).toBe("turn_completed");
  });

  it("revokes the token on BadDeviceToken", async () => {
    respond = () => new Response(JSON.stringify({ ok: false, status: 400, reason: "BadDeviceToken" }), { status: 200 });
    await client().handleEvent(event("turn_completed"));
    expect(stores.devices.byId("dev-1")?.apnsToken).toBeNull();
  });

  it("revokes the token on Unregistered", async () => {
    respond = () => new Response(JSON.stringify({ ok: false, status: 410, reason: "Unregistered" }), { status: 200 });
    await client().handleEvent(event("turn_completed"));
    expect(stores.devices.byId("dev-1")?.apnsToken).toBeNull();
  });

  it("keeps the token on TopicDisallowed (a topic misconfiguration)", async () => {
    respond = () => new Response(JSON.stringify({ ok: false, status: 400, reason: "TopicDisallowed" }), { status: 200 });
    await client().handleEvent(event("turn_completed"));
    expect(stores.devices.byId("dev-1")?.apnsToken).toBe("t".repeat(64));
  });

  it("keeps the token on DeviceTokenNotForTopic (a topic misconfiguration)", async () => {
    respond = () => new Response(JSON.stringify({ ok: false, status: 400, reason: "DeviceTokenNotForTopic" }), { status: 200 });
    await client().handleEvent(event("turn_completed"));
    expect(stores.devices.byId("dev-1")?.apnsToken).toBe("t".repeat(64));
  });

  it("keeps the token on a transient error (TooManyRequests)", async () => {
    respond = () => new Response(JSON.stringify({ ok: false, status: 429, reason: "TooManyRequests" }), { status: 200 });
    await client().handleEvent(event("turn_completed"));
    expect(stores.devices.byId("dev-1")?.apnsToken).toBe("t".repeat(64));
  });

  it("keeps the token and throws nothing on a relay 5xx", async () => {
    respond = () => new Response(JSON.stringify({ error: "boom" }), { status: 502 });
    await expect(client().handleEvent(event("turn_completed"))).resolves.toBeUndefined();
    expect(stores.devices.byId("dev-1")?.apnsToken).toBe("t".repeat(64));
  });

  it("throws nothing on network failure (never takes down turn execution)", async () => {
    const broken = new PushClient({
      stores, settings: () => settings,
      fetchImpl: (async () => { throw new Error("network down"); }) as unknown as typeof fetch,
    });
    await expect(broken.handleEvent(event("turn_completed"))).resolves.toBeUndefined();
  });
});
