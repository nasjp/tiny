import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db.js";
import { createStores } from "../src/stores.js";
import { addProfile } from "../src/profiles.js";
import { PermissionBroker } from "../src/permission-broker.js";
import { FileOutbox } from "../src/outbox.js";
import { ConflictError, NotFoundError, SessionManager } from "../src/session-manager.js";
import type { AgentAdapter, RunTurnParams } from "../src/adapter.js";
import type { EventRecord } from "../src/types.js";

/** Fake session-token issuer for tests (stands in for AuthService.issueSessionToken / revokeSessionTokens) */
function fakeTokens() {
  const issued: Array<{ sessionId: string; token: string }> = [];
  const revoked: string[] = [];
  let n = 0;
  return {
    issued,
    revoked,
    issueSessionToken: (sessionId: string) => {
      const token = `tok-${++n}`;
      issued.push({ sessionId, token });
      return token;
    },
    revokeSessionTokens: (sessionId: string) => {
      revoked.push(sessionId);
    },
  };
}

function makeManager(adapter: AgentAdapter, { withTokens = true }: { withTokens?: boolean } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-sm-"));
  const profilesDir = path.join(home, "profiles");
  const outboxDir = path.join(home, "outbox");
  fs.mkdirSync(outboxDir, { recursive: true });
  addProfile(profilesDir, "work");
  addProfile(profilesDir, "oc", "opencode");
  const stores = createStores(openDb(":memory:"));
  const tokens = fakeTokens();
  const manager = new SessionManager({
    stores, profilesDir, adapters: { claude: adapter, opencode: adapter },
    broker: new PermissionBroker(1000),
    outbox: new FileOutbox(outboxDir, stores.files),
    mcpLaunch: (sessionId, token) => ({
      command: "node",
      args: ["cli.js", "mcp-server"],
      env: { TINY_SESSION_ID: sessionId, TINY_TOKEN: token },
    }),
    ...(withTokens ? { sessionTokens: tokens } : {}),
  });
  return { manager, stores, home, tokens };
}

const okAdapter: AgentAdapter = {
  async runTurn(p: RunTurnParams) {
    p.emit({ type: "turn_started", payload: {} });
    p.emit({ type: "turn_completed", payload: {} });
    return { agentSessionId: "agent-1", costUsd: 0.01, resultText: "ok" };
  },
};

describe("SessionManager", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cwd-"));
  });

  it("passes a model specified at creation through to the adapter's runTurn", async () => {
    let seenModel: string | null | undefined;
    const capture: AgentAdapter = {
      async runTurn(p: RunTurnParams) {
        seenModel = p.model;
        return { agentSessionId: "agent-1", costUsd: null, resultText: null };
      },
    };
    const { manager } = makeManager(capture);
    const s = manager.createSession({ profile: "work", cwd, model: "opus" });
    expect(s.model).toBe("opus");
    manager.startTurn(s.id, "hi");
    await manager.waitForIdle(s.id);
    expect(seenModel).toBe("opus");
    // Unspecified is null (follows the CLI default)
    const s2 = manager.createSession({ profile: "work", cwd });
    expect(s2.model).toBeNull();
  });

  it("createSession validates and creates an idle session", () => {
    const { manager } = makeManager(okAdapter);
    const s = manager.createSession({ profile: "work", cwd });
    expect(s.status).toBe("idle");
    expect(s.permissionMode).toBe("default");
    expect(manager.listSessions()).toHaveLength(1);
    expect(() => manager.createSession({ profile: "nope", cwd })).toThrow();
    expect(() => manager.createSession({ profile: "work", cwd: "/no/such/dir" })).toThrow(NotFoundError);
    expect(() => manager.getSession("missing")).toThrow(NotFoundError);
  });

  it("adopts a CLI session idempotently and backfills the transcript", () => {
    const { manager, stores, home } = makeManager(okAdapter);
    const configDir = path.join(home, "external-claude");
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cwd-"));
    const file = path.join(configDir, "projects", cwd.replace(/[/.]/g, "-"), "agent-9.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      JSON.stringify({ type: "ai-title", aiTitle: "From CLI" }),
      JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "hello" } }),
      JSON.stringify({ type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "hi" }] } }),
    ].join("\n") + "\n");
    addProfile(path.join(home, "profiles"), "local", "claude", configDir);

    const first = manager.adoptSession({ profile: "local", cwd, agentSessionId: "agent-9" });
    expect(first.adopted).toBe(true);
    expect(first.session.agentSessionId).toBe("agent-9");
    expect(first.session.title).toBe("From CLI");
    expect(first.session.sourceCursor).toBe("a1");
    expect(stores.events.listSince(first.session.id, 0).map((e) => e.type))
      .toEqual(["user_message", "assistant_text"]);

    // SessionStart fires again on resume: must not create a second row
    const second = manager.adoptSession({ profile: "local", cwd, agentSessionId: "agent-9" });
    expect(second.adopted).toBe(false);
    expect(second.session.id).toBe(first.session.id);
    expect(stores.sessions.list().filter((s) => s.agentSessionId === "agent-9")).toHaveLength(1);
    // and must not duplicate the events
    expect(stores.events.listSince(first.session.id, 0)).toHaveLength(2);
  });

  it("adopts a session with no transcript yet", () => {
    const { manager, home } = makeManager(okAdapter);
    const configDir = path.join(home, "external-claude");
    fs.mkdirSync(configDir, { recursive: true });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cwd-"));
    addProfile(path.join(home, "profiles"), "local", "claude", configDir);
    const r = manager.adoptSession({ profile: "local", cwd, agentSessionId: "agent-x" });
    expect(r.adopted).toBe(true);
    expect(r.session.title).toBeNull();
    expect(r.session.sourceCursor).toBeNull();
  });

  it("rejects adopting into a cwd that does not exist", () => {
    const { manager, home } = makeManager(okAdapter);
    const configDir = path.join(home, "external-claude");
    fs.mkdirSync(configDir, { recursive: true });
    addProfile(path.join(home, "profiles"), "local", "claude", configDir);
    expect(() => manager.adoptSession({ profile: "local", cwd: "/no/such/dir", agentSessionId: "a" }))
      .toThrow(NotFoundError);
  });

  it("syncTranscript appends only new records", () => {
    const { manager, stores, home } = makeManager(okAdapter);
    const configDir = path.join(home, "external-claude");
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cwd-"));
    const file = path.join(configDir, "projects", cwd.replace(/[/.]/g, "-"), "agent-7.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "one" } }) + "\n");
    addProfile(path.join(home, "profiles"), "local", "claude", configDir);
    const { session } = manager.adoptSession({ profile: "local", cwd, agentSessionId: "agent-7" });
    expect(stores.events.count(session.id)).toBe(1);

    fs.appendFileSync(file, JSON.stringify({ type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "two" }] } }) + "\n");
    expect(manager.syncTranscript(session.id)).toBe(1);
    expect(stores.events.count(session.id)).toBe(2);
    // a second sync with no new records adds nothing
    expect(manager.syncTranscript(session.id)).toBe(0);
  });

  // Tiny and the user's CLI append to the SAME transcript file, so a session that already carries
  // natively emitted events must not import them back when the CLI hook adopts it again
  it("seeds the cursor without importing when the session already has events", () => {
    const { manager, stores, home } = makeManager(okAdapter);
    const configDir = path.join(home, "external-claude");
    fs.mkdirSync(configDir, { recursive: true });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cwd-"));
    addProfile(path.join(home, "profiles"), "local", "claude", configDir);
    const s = manager.createSession({ profile: "local", cwd });
    stores.sessions.patch(s.id, { agentSessionId: "agent-1" });
    stores.events.append(s.id, "user_message", { text: "sent from the phone" });
    expect(stores.sessions.get(s.id)!.sourceCursor).toBeNull();

    // the same exchange, as Claude Code wrote it to the transcript
    const file = path.join(configDir, "projects", cwd.replace(/[/.]/g, "-"), "agent-1.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "sent from the phone" } }),
      JSON.stringify({ type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "on it" }] } }),
    ].join("\n") + "\n");

    const r = manager.adoptSession({ profile: "local", cwd, agentSessionId: "agent-1" });
    expect(r.adopted).toBe(false);
    expect(r.session.id).toBe(s.id);
    // nothing re-imported, and the cursor now sits at the tail so later CLI records still arrive
    expect(stores.events.count(s.id)).toBe(1);
    expect(r.session.sourceCursor).toBe("a1");

    fs.appendFileSync(file, JSON.stringify({ type: "user", uuid: "u2", message: { role: "user", content: "from the CLI" } }) + "\n");
    expect(manager.syncTranscript(s.id)).toBe(1);
  });

  it("advances the cursor past tiny's own turn so the next sync does not replay it", async () => {
    let onTurn: (() => void) | null = null;
    const writesTranscript: AgentAdapter = {
      async runTurn(p: RunTurnParams) {
        p.emit({ type: "assistant_text", payload: { text: "done" } });
        onTurn?.();
        return { agentSessionId: "agent-3", costUsd: null, resultText: "ok" };
      },
    };
    const { manager, stores, home } = makeManager(writesTranscript);
    const configDir = path.join(home, "external-claude");
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cwd-"));
    const file = path.join(configDir, "projects", cwd.replace(/[/.]/g, "-"), "agent-3.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "from the CLI" } }) + "\n");
    addProfile(path.join(home, "profiles"), "local", "claude", configDir);
    const { session } = manager.adoptSession({ profile: "local", cwd, agentSessionId: "agent-3" });
    expect(session.sourceCursor).toBe("u1");

    // the SDK resumes the same session, so tiny's turn lands in the same file
    onTurn = () => fs.appendFileSync(file, [
      JSON.stringify({ type: "user", uuid: "u2", message: { role: "user", content: "from the phone" } }),
      JSON.stringify({ type: "assistant", uuid: "a2", message: { content: [{ type: "text", text: "done" }] } }),
    ].join("\n") + "\n");
    manager.startTurn(session.id, "from the phone");
    await manager.waitForIdle(session.id);

    const count = stores.events.count(session.id);
    expect(manager.getSession(session.id).sourceCursor).toBe("a2");
    expect(manager.syncTranscript(session.id)).toBe(0);
    expect(stores.events.count(session.id)).toBe(count);
  });

  // A 139MB transcript costs ~250ms and ~800MB of RSS to parse, and the events endpoint asks on
  // every poll, so an unchanged file must cost a single stat
  it("syncTranscript does not re-read a transcript whose path, size and mtime are unchanged", () => {
    const { manager, stores, home } = makeManager(okAdapter);
    const configDir = path.join(home, "external-claude");
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cwd-"));
    const file = path.join(configDir, "projects", cwd.replace(/[/.]/g, "-"), "agent-8.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    addProfile(path.join(home, "profiles"), "local", "claude", configDir);

    const first = JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "one" } });
    // an assistant record the second write smuggles in, and a bookkeeping record padded to its exact
    // byte length: only a re-read of the file could tell the two versions apart
    const later = JSON.stringify({ type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "two" }] } });
    let filler = "";
    for (let pad = 0; filler.length !== later.length; pad++) {
      filler = JSON.stringify({ type: "mode", pad: "x".repeat(pad) });
      if (filler.length > later.length) throw new Error("cannot pad to the same length");
    }
    // one fixed timestamp for both writes, so the two stats agree to the nanosecond
    const t = new Date(1_700_000_000_000);
    fs.writeFileSync(file, `${first}\n${filler}\n`);
    fs.utimesSync(file, t, t);

    const { session } = manager.adoptSession({ profile: "local", cwd, agentSessionId: "agent-8" });
    expect(stores.events.count(session.id)).toBe(1);
    expect(manager.getSession(session.id).sourceCursor).toBe("u1");

    fs.writeFileSync(file, `${first}\n${later}\n`);
    fs.utimesSync(file, t, t);
    expect(manager.syncTranscript(session.id)).toBe(0);
    expect(stores.events.count(session.id)).toBe(1);

    // a real append changes the size, so it is read — and brings the smuggled record along
    fs.appendFileSync(file, JSON.stringify({ type: "user", uuid: "u2", message: { role: "user", content: "three" } }) + "\n");
    expect(manager.syncTranscript(session.id)).toBe(2);
  });

  it("syncTranscript is a no-op for a non-claude agent", () => {
    const { manager, stores } = makeManager(okAdapter);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cwd-"));
    // makeManager creates an opencode profile named "oc"
    const s = manager.createSession({ profile: "oc", cwd });
    stores.sessions.patch(s.id, { agentSessionId: "agent-oc" });
    expect(manager.syncTranscript(s.id)).toBe(0);
  });

  it("syncTranscript returns 0 when the profile's config dir has gone away", () => {
    const { manager, home } = makeManager(okAdapter);
    const configDir = path.join(home, "vanishing-claude");
    fs.mkdirSync(configDir, { recursive: true });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cwd-"));
    addProfile(path.join(home, "profiles"), "gone", "claude", configDir);
    const { session } = manager.adoptSession({ profile: "gone", cwd, agentSessionId: "agent-gone" });
    // the user moved or deleted their CLAUDE_CONFIG_DIR after adoption
    fs.rmSync(configDir, { recursive: true, force: true });
    expect(() => manager.syncTranscript(session.id)).not.toThrow();
    expect(manager.syncTranscript(session.id)).toBe(0);
  });

  it("discardIfEmpty removes a session with no events and keeps one with events", () => {
    const { manager, stores, home } = makeManager(okAdapter);
    const configDir = path.join(home, "external-claude");
    fs.mkdirSync(configDir, { recursive: true });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cwd-"));
    addProfile(path.join(home, "profiles"), "local", "claude", configDir);
    const { session } = manager.adoptSession({ profile: "local", cwd, agentSessionId: "agent-empty" });
    expect(stores.events.count(session.id)).toBe(0);
    expect(manager.discardIfEmpty("agent-empty")).toBe(true);
    expect(stores.sessions.get(session.id)).toBeNull();
    // unknown id is a no-op
    expect(manager.discardIfEmpty("agent-empty")).toBe(false);
  });

  it("on startTurn completion: agentSessionId, title, back to idle, and events persisted", async () => {
    const { manager, stores } = makeManager(okAdapter);
    const s = manager.createSession({ profile: "work", cwd });
    const seen: EventRecord[] = [];
    manager.on("event", (e: EventRecord) => seen.push(e));
    manager.startTurn(s.id, "This is the first prompt");
    await manager.waitForIdle(s.id);
    const after = manager.getSession(s.id);
    expect(after.status).toBe("idle");
    expect(after.agentSessionId).toBe("agent-1");
    expect(after.title).toBe("This is the first prompt");
    const types = stores.events.listSince(s.id, 0).map((e) => e.type);
    // user_message persists the user's utterance (without it, the client history shows no own bubble)
    expect(types).toEqual(["user_message", "turn_started", "turn_completed"]);
    expect(seen.map((e) => e.type)).toEqual(types);
    expect(stores.events.listSince(s.id, 0)[0]?.payload).toEqual({ text: "This is the first prompt" });
  });

  it("startTurn with images saves to the outbox and records imageFileIds on user_message", async () => {
    const { manager, stores } = makeManager(okAdapter);
    const s = manager.createSession({ profile: "work", cwd });
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    manager.startTurn(s.id, "Look at the image", [
      { data: bytes.toString("base64"), mediaType: "image/jpeg" },
    ]);
    await manager.waitForIdle(s.id);
    const msg = stores.events.listSince(s.id, 0)[0];
    expect(msg?.type).toBe("user_message");
    const payload = msg?.payload as { imageCount?: number; imageFileIds?: string[] };
    expect(payload.imageCount).toBe(1);
    expect(payload.imageFileIds).toHaveLength(1);
    // Retrievable by fileId, and the stored body matches the uploaded content
    const rec = stores.files.get(payload.imageFileIds![0]!);
    expect(rec?.mime).toBe("image/jpeg");
    expect(fs.readFileSync(rec!.storedPath)).toEqual(bytes);
  });

  it("startTurn while running and while detached is a ConflictError", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((r) => (release = r));
    const slow: AgentAdapter = {
      async runTurn(p) {
        p.emit({ type: "turn_started", payload: {} });
        await blocked;
        return { agentSessionId: "agent-1", costUsd: null, resultText: null };
      },
    };
    const { manager } = makeManager(slow);
    const s = manager.createSession({ profile: "work", cwd });
    manager.startTurn(s.id, "a");
    expect(() => manager.startTurn(s.id, "b")).toThrow(ConflictError);
    release();
    await manager.waitForIdle(s.id);
    manager.setDetached(s.id, true);
    expect(manager.getSession(s.id).status).toBe("detached");
    expect(() => manager.startTurn(s.id, "c")).toThrow(ConflictError);
    manager.setDetached(s.id, false);
    expect(manager.getSession(s.id).status).toBe("idle");
  });

  it("refuses a turn while the agent's own CLI has the session open", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-sm-"));
    const profilesDir = path.join(home, "profiles");
    const outboxDir = path.join(home, "outbox");
    fs.mkdirSync(outboxDir, { recursive: true });
    addProfile(profilesDir, "work");
    const stores = createStores(openDb(":memory:"));
    let live: boolean | null = true;
    const manager = new SessionManager({
      stores, profilesDir, adapters: { claude: okAdapter },
      broker: new PermissionBroker(1000),
      outbox: new FileOutbox(outboxDir, stores.files),
      isCliLive: () => live,
    });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cwd-"));
    const s = manager.createSession({ profile: "work", cwd });

    expect(() => manager.startTurn(s.id, "hi")).toThrow(ConflictError);

    // once the CLI is gone, sending works again
    live = false;
    expect(() => manager.startTurn(s.id, "hi")).not.toThrow();
    await manager.waitForIdle(s.id);
  });

  it("allows a turn when liveness cannot be determined", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-sm-"));
    const profilesDir = path.join(home, "profiles");
    const outboxDir = path.join(home, "outbox");
    fs.mkdirSync(outboxDir, { recursive: true });
    addProfile(profilesDir, "work");
    const stores = createStores(openDb(":memory:"));
    const manager = new SessionManager({
      stores, profilesDir, adapters: { claude: okAdapter },
      broker: new PermissionBroker(1000),
      outbox: new FileOutbox(outboxDir, stores.files),
      isCliLive: () => null,
    });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cwd-"));
    const s = manager.createSession({ profile: "work", cwd });
    expect(() => manager.startTurn(s.id, "hi")).not.toThrow();
    await manager.waitForIdle(s.id);
  });

  it("emits turn_failed and returns to idle when the adapter throws", async () => {
    const failing: AgentAdapter = {
      async runTurn() {
        throw new Error("boom");
      },
    };
    const { manager, stores } = makeManager(failing);
    const s = manager.createSession({ profile: "work", cwd });
    manager.startTurn(s.id, "x");
    await manager.waitForIdle(s.id);
    expect(manager.getSession(s.id).status).toBe("idle");
    const types = stores.events.listSince(s.id, 0).map((e) => e.type);
    expect(types).toContain("turn_failed");
  });

  it("normalizes error to interrupted, not the agent's wording, when the adapter throws mid-interrupt (interrupt during startup)", async () => {
    const slowStart: AgentAdapter = {
      async runTurn(p: RunTurnParams) {
        await new Promise<void>((resolve) => p.signal.addEventListener("abort", () => resolve(), { once: true }));
        throw new Error("Cursor session/load failed: Cursor interrupted before the turn started");
      },
    };
    const { manager, stores } = makeManager(slowStart);
    const s = manager.createSession({ profile: "work", cwd });
    manager.startTurn(s.id, "x");
    await new Promise((r) => setTimeout(r, 10));
    manager.interrupt(s.id);
    await manager.waitForIdle(s.id);
    const failed = stores.events.listSince(s.id, 0).find((e) => e.type === "turn_failed");
    expect(failed?.payload).toEqual({ error: "interrupted" });
    expect(stores.events.listSince(s.id, 0).some((e) => e.type === "auth_error")).toBe(false);
    expect(manager.getSession(s.id).status).toBe("idle");
  });

  it("turns a permission request into permission_requested/resolved events and returns the decision", async () => {
    const asking: AgentAdapter = {
      async runTurn(p) {
        const d = await p.requestPermission("Bash", { command: "ls" });
        p.emit({ type: "turn_completed", payload: { got: d.behavior } });
        return { agentSessionId: "agent-1", costUsd: null, resultText: null };
      },
    };
    const { manager, stores } = makeManager(asking);
    const s = manager.createSession({ profile: "work", cwd });
    const gotRequest = new Promise<EventRecord>((resolve) => {
      manager.on("event", (e: EventRecord) => {
        if (e.type === "permission_requested") resolve(e);
      });
    });
    manager.startTurn(s.id, "x");
    const req = await gotRequest;
    expect(manager.listPendingPermissions(s.id)).toHaveLength(1);
    // Requests without a hint carry no kind / summary (legacy adapter compat)
    expect(req.payload.kind).toBeUndefined();
    expect(manager.resolvePermission(req.payload.reqId as string, { behavior: "allow" })).toBe(true);
    await manager.waitForIdle(s.id);
    const types = stores.events.listSince(s.id, 0).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["permission_requested", "permission_resolved", "turn_completed"]));
  });

  it("passes resolvePermission's updatedInput through to the adapter's decision (AskUserQuestion)", async () => {
    let got: unknown;
    const asking: AgentAdapter = {
      async runTurn(p) {
        got = await p.requestPermission("AskUserQuestion", { questions: [] });
        p.emit({ type: "turn_completed", payload: {} });
        return { agentSessionId: "agent-1", costUsd: null, resultText: null };
      },
    };
    const { manager, stores } = makeManager(asking);
    const s = manager.createSession({ profile: "work", cwd });
    const gotRequest = new Promise<EventRecord>((resolve) => {
      manager.on("event", (e: EventRecord) => {
        if (e.type === "permission_requested") resolve(e);
      });
    });
    manager.startTurn(s.id, "x");
    const req = await gotRequest;
    const updatedInput = { questions: [], answers: { "Which one?": "Option A" } };
    expect(manager.resolvePermission(req.payload.reqId as string, { behavior: "allow", updatedInput })).toBe(true);
    await manager.waitForIdle(s.id);
    expect(got).toEqual({ behavior: "allow", updatedInput });
    // The answer also lands on the permission_resolved event (for client history display)
    const resolved = stores.events.listSince(s.id, 0).find((e) => e.type === "permission_resolved");
    expect(resolved?.payload).toEqual({
      reqId: req.payload.reqId,
      behavior: "allow",
      answers: { "Which one?": "Option A" },
    });
  });

  it("interrupt fires the AbortSignal", async () => {
    let aborted = false;
    const interruptible: AgentAdapter = {
      async runTurn(p) {
        p.emit({ type: "turn_started", payload: {} });
        await new Promise<void>((resolve) => {
          p.signal.addEventListener("abort", () => {
            aborted = true;
            resolve();
          });
        });
        return { agentSessionId: "agent-1", costUsd: null, resultText: null };
      },
    };
    const { manager } = makeManager(interruptible);
    const s = manager.createSession({ profile: "work", cwd });
    manager.startTurn(s.id, "x");
    manager.interrupt(s.id);
    await manager.waitForIdle(s.id);
    expect(aborted).toBe(true);
  });

  it("archive: idle succeeds, disappears from the list, and unarchive brings it back", () => {
    const { manager } = makeManager(okAdapter);
    const s = manager.createSession({ profile: "work", cwd });
    const archived = manager.updateSession(s.id, { archived: true });
    expect(archived.archivedAt).toBeTruthy();
    expect(manager.listSessions()).toHaveLength(0);
    expect(manager.listSessions(undefined, true).map((x) => x.id)).toEqual([s.id]);
    const restored = manager.updateSession(s.id, { archived: false });
    expect(restored.archivedAt).toBeNull();
    expect(manager.listSessions()).toHaveLength(1);
  });

  it("archive: running / detached is 409, interrupted succeeds", () => {
    const { manager, stores } = makeManager(okAdapter);
    const s = manager.createSession({ profile: "work", cwd });
    stores.sessions.patch(s.id, { status: "running" });
    expect(() => manager.updateSession(s.id, { archived: true })).toThrow(ConflictError);
    stores.sessions.patch(s.id, { status: "detached" });
    expect(() => manager.updateSession(s.id, { archived: true })).toThrow(ConflictError);
    stores.sessions.patch(s.id, { status: "interrupted" });
    expect(manager.updateSession(s.id, { archived: true }).archivedAt).toBeTruthy();
    // unarchive has no status constraint
    expect(manager.updateSession(s.id, { archived: false }).archivedAt).toBeNull();
  });

  it("puts permission-request hints (kind / summary) on the event and the pending list", async () => {
    const asking: AgentAdapter = {
      async runTurn(p) {
        await p.requestPermission("Bash", { command: "rm -rf build" }, { kind: "execute", summary: "rm -rf build" });
        p.emit({ type: "turn_completed", payload: {} });
        return { agentSessionId: "agent-1", costUsd: null, resultText: null };
      },
    };
    const { manager } = makeManager(asking);
    const s = manager.createSession({ profile: "work", cwd });
    const gotRequest = new Promise<EventRecord>((resolve) => {
      manager.on("event", (e: EventRecord) => {
        if (e.type === "permission_requested") resolve(e);
      });
    });
    manager.startTurn(s.id, "x");
    const req = await gotRequest;
    expect(req.payload).toMatchObject({ toolName: "Bash", kind: "execute", summary: "rm -rf build" });
    expect(manager.listPendingPermissions(s.id)[0]).toMatchObject({ kind: "execute", summary: "rm -rf build" });
    manager.resolvePermission(req.payload.reqId as string, { behavior: "allow" });
    await manager.waitForIdle(s.id);
  });

  it("passes the adapter the MCP launch spec built via mcpLaunch(sessionId)", async () => {
    let got: RunTurnParams["mcpServer"] | undefined;
    const spy: AgentAdapter = {
      async runTurn(p) {
        got = p.mcpServer;
        p.emit({ type: "turn_completed", payload: {} });
        return { agentSessionId: "agent-1", costUsd: null, resultText: null };
      },
    };
    const { manager } = makeManager(spy);
    const s = manager.createSession({ profile: "work", cwd });
    manager.startTurn(s.id, "x");
    await manager.waitForIdle(s.id);
    expect(got).toEqual({ command: "node", args: ["cli.js", "mcp-server"], env: { TINY_SESSION_ID: s.id, TINY_TOKEN: "tok-1" } });
  });

  it("issues a session token per turn, passes it to mcpLaunch, and revokes it at turn end", async () => {
    let seen: RunTurnParams["mcpServer"] | undefined;
    const capture: AgentAdapter = {
      async runTurn(p: RunTurnParams) {
        seen = p.mcpServer;
        p.emit({ type: "turn_started", payload: { agentSessionId: "a" } });
        p.emit({ type: "turn_completed", payload: {} });
        return { agentSessionId: "a", costUsd: null, resultText: null };
      },
    };
    const { manager, tokens } = makeManager(capture);
    const s = manager.createSession({ profile: "work", cwd });
    manager.startTurn(s.id, "hi");
    await manager.waitForIdle(s.id);
    expect(tokens.issued).toEqual([{ sessionId: s.id, token: "tok-1" }]);
    expect(seen?.env).toEqual({ TINY_SESSION_ID: s.id, TINY_TOKEN: "tok-1" });
    expect(tokens.revoked).toEqual([s.id]);
  });

  it("still revokes the token when the adapter throws", async () => {
    const failing: AgentAdapter = { async runTurn() { throw new Error("boom"); } };
    const { manager, tokens } = makeManager(failing);
    const s = manager.createSession({ profile: "work", cwd });
    manager.startTurn(s.id, "x");
    await manager.waitForIdle(s.id);
    expect(tokens.revoked).toEqual([s.id]);
  });

  it("with no sessionTokens (tests etc.), mcpLaunch gets neither a dummy nor an empty token and mcpServer is null", async () => {
    // A setup with mcpLaunch but no sessionTokens attaches no MCP (never falls back to the CLI token)
    let seen: RunTurnParams["mcpServer"] | undefined = { command: "x", args: [], env: {} };
    const capture: AgentAdapter = {
      async runTurn(p: RunTurnParams) { seen = p.mcpServer; return { agentSessionId: "a", costUsd: null, resultText: null }; },
    };
    const { manager } = makeManager(capture, { withTokens: false });
    const s = manager.createSession({ profile: "work", cwd });
    manager.startTurn(s.id, "hi");
    await manager.waitForIdle(s.id);
    expect(seen).toBeNull();
  });

  it("saveUserFile stores to the outbox and records a file_sent event (the mcp-server path)", async () => {
    const { manager, stores, home } = makeManager(okAdapter);
    const s = manager.createSession({ profile: "work", cwd });
    const src = path.join(home, "report.html");
    fs.writeFileSync(src, "<h1>hi</h1>");
    const rec = manager.saveUserFile(s.id, src, "cap");
    expect(rec.mime).toBe("text/html");
    const ev = stores.events.listSince(s.id, 0).find((e) => e.type === "file_sent");
    expect(ev?.payload).toMatchObject({ fileId: rec.id, mime: "text/html", caption: "cap", name: src });
    expect(() => manager.saveUserFile("nope", src)).toThrow(NotFoundError);
  });

  it("picks the adapter matching the profile's agent, defaulting permissionMode to the first capabilities entry", async () => {
    const seen: string[] = [];
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-sm-"));
    const profilesDir = path.join(home, "profiles");
    const outboxDir = path.join(home, "outbox");
    fs.mkdirSync(outboxDir, { recursive: true });
    addProfile(profilesDir, "work");
    addProfile(profilesDir, "oc", "opencode");
    const mk = (name: string): AgentAdapter => ({
      async runTurn(p: RunTurnParams) {
        seen.push(`${name}:${p.permissionMode}`);
        p.emit({ type: "turn_started", payload: { agentSessionId: "a" } });
        p.emit({ type: "turn_completed", payload: {} });
        return { agentSessionId: "a", costUsd: null, resultText: null };
      },
    });
    const stores = createStores(openDb(":memory:"));
    const manager = new SessionManager({
      stores, profilesDir, adapters: { claude: mk("claude"), opencode: mk("opencode") },
      broker: new PermissionBroker(1000), outbox: new FileOutbox(outboxDir, stores.files),
    });
    const s1 = manager.createSession({ profile: "work", cwd });
    const s2 = manager.createSession({ profile: "oc", cwd });
    expect(s1.permissionMode).toBe("default");
    expect(s2.permissionMode).toBe("ask");
    expect(s2.agent).toBe("opencode");
    manager.startTurn(s1.id, "hi");
    await manager.waitForIdle(s1.id);
    manager.startTurn(s2.id, "hi");
    await manager.waitForIdle(s2.id);
    expect(seen).toEqual(["claude:default", "opencode:ask"]);
  });

  it("a turn for an agent with no adapter becomes turn_failed", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-sm-"));
    const profilesDir = path.join(home, "profiles");
    const outboxDir = path.join(home, "outbox");
    fs.mkdirSync(outboxDir, { recursive: true });
    addProfile(profilesDir, "oc", "opencode");
    const stores = createStores(openDb(":memory:"));
    const manager = new SessionManager({
      stores, profilesDir, adapters: {},
      broker: new PermissionBroker(1000), outbox: new FileOutbox(outboxDir, stores.files),
    });
    const s = manager.createSession({ profile: "oc", cwd });
    manager.startTurn(s.id, "hi");
    await manager.waitForIdle(s.id);
    const types = stores.events.listSince(s.id, 0).map((e: EventRecord) => e.type);
    expect(types).toEqual(["user_message", "turn_failed"]);
    expect(manager.getSession(s.id).status).toBe("idle");
  });
});
