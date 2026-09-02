import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db.js";
import { createStores } from "../src/stores.js";
import { addProfile } from "../src/profiles.js";
import { PermissionBroker } from "../src/permission-broker.js";
import { FileOutbox } from "../src/outbox.js";
import { ConflictError, NotFoundError, SessionManager, type PeerBridge, type SessionManagerDeps } from "../src/session-manager.js";
import type { AgentAdapter, RunTurnParams } from "../src/adapter.js";
import { PEER_STOP, type PeerFrame, type PeerStatus, type PeerTarget } from "../src/claude-peer.js";
import type { LiveSessionEntry } from "../src/claude-live.js";
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

function makeManager(
  adapter: AgentAdapter,
  { withTokens = true, deps = {} }: { withTokens?: boolean; deps?: Partial<SessionManagerDeps> } = {},
) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-sm-"));
  const profilesDir = path.join(home, "profiles");
  const outboxDir = path.join(home, "outbox");
  fs.mkdirSync(outboxDir, { recursive: true });
  addProfile(profilesDir, "work");
  addProfile(profilesDir, "oc", "opencode");
  addProfile(profilesDir, "cx", "codex");
  const stores = createStores(openDb(":memory:"));
  const tokens = fakeTokens();
  const manager = new SessionManager({
    stores, profilesDir, adapters: { claude: adapter, opencode: adapter, codex: adapter },
    broker: new PermissionBroker(1000),
    outbox: new FileOutbox(outboxDir, stores.files),
    mcpLaunch: (sessionId, token) => ({
      command: "node",
      args: ["cli.js", "mcp-server"],
      env: { TINY_SESSION_ID: sessionId, TINY_TOKEN: token },
    }),
    ...(withTokens ? { sessionTokens: tokens } : {}),
    ...deps,
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

  // A session that appears from the Mac side (hook / `tiny handoff` / `tiny new`) is announced so
  // the phone can be told; the phone's own creations are not (it already knows)
  it("announces a session the first time it is adopted, not on the hook's repeats", () => {
    const { manager, home } = makeManager(okAdapter);
    fs.mkdirSync(path.join(home, "external-claude"), { recursive: true });
    addProfile(path.join(home, "profiles"), "local", "claude", path.join(home, "external-claude"));
    const announced: string[] = [];
    manager.on("session_added", (s: { id: string }) => announced.push(s.id));
    const first = manager.adoptSession({ profile: "local", cwd, agentSessionId: "agent-9" });
    manager.adoptSession({ profile: "local", cwd, agentSessionId: "agent-9" });
    expect(announced).toEqual([first.session.id]);
  });

  it("announces a created session only when asked to", () => {
    const { manager } = makeManager(okAdapter);
    const announced: string[] = [];
    manager.on("session_added", (s: { id: string }) => announced.push(s.id));
    manager.createSession({ profile: "work", cwd });
    expect(announced).toEqual([]);
    const s = manager.createSession({ profile: "work", cwd }, { announce: true });
    expect(announced).toEqual([s.id]);
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
  // The regression guard for C2 as a whole: nothing else in this suite crosses the
  // adopt -> turn -> adopt boundary, which is exactly where the double import lived.
  // Two sessions, because the three halves fire in different states: seeding needs a null cursor,
  // the completion advance needs a non-null one, and the running guard covers the hook that fires
  // WHILE the turn is still writing
  it("a session that was adopted, then ran one turn, gains no duplicate events when adopted again", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-sm-"));
    const profilesDir = path.join(home, "profiles");
    const outboxDir = path.join(home, "outbox");
    fs.mkdirSync(outboxDir, { recursive: true });
    const configDir = path.join(home, "external-claude");
    fs.mkdirSync(configDir, { recursive: true });
    addProfile(profilesDir, "local", "claude", configDir);
    const stores = createStores(openDb(":memory:"));

    // stands in for the SDK: appends to the same transcript the CLI writes, and — because the SDK
    // reads every settings source — trips the SessionStart hook while the turn is still running
    let file = "";
    let agentId = "";
    let hook: (() => void) | null = null;
    const sdkLike: AgentAdapter = {
      async runTurn(p: RunTurnParams) {
        fs.appendFileSync(file, JSON.stringify({ type: "user", uuid: "t-u", message: { role: "user", content: "from the phone" } }) + "\n");
        hook?.();
        p.emit({ type: "assistant_text", payload: { text: "done" } });
        fs.appendFileSync(file, JSON.stringify({ type: "assistant", uuid: "t-a", message: { content: [{ type: "text", text: "done" }] } }) + "\n");
        hook?.();
        return { agentSessionId: agentId, costUsd: null, resultText: "ok" };
      },
    };
    const manager = new SessionManager({
      stores, profilesDir, adapters: { claude: sdkLike },
      broker: new PermissionBroker(1000),
      outbox: new FileOutbox(outboxDir, stores.files),
    });

    // (1) adopted from a CLI session that already had a conversation: cursor is non-null
    const cwdA = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cwd-"));
    agentId = "agent-x";
    file = path.join(configDir, "projects", cwdA.replace(/[/.]/g, "-"), "agent-x.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "from the CLI" } }) + "\n");
    const a = manager.adoptSession({ profile: "local", cwd: cwdA, agentSessionId: "agent-x" }).session;
    expect(a.sourceCursor).toBe("u1");
    hook = () => manager.adoptSession({ profile: "local", cwd: cwdA, agentSessionId: "agent-x" });
    manager.startTurn(a.id, "from the phone");
    await manager.waitForIdle(a.id);
    manager.adoptSession({ profile: "local", cwd: cwdA, agentSessionId: "agent-x" });
    // the CLI's line, then the turn — each exactly once. Counting only across the final adopt would
    // miss the hook that fired mid-turn, whose duplicates are already in the log by then
    expect(stores.events.listSince(a.id, 0).map((e) => [e.type, (e.payload as { text?: string }).text]))
      .toEqual([
        ["user_message", "from the CLI"],
        ["user_message", "from the phone"],
        ["assistant_text", "done"],
      ]);

    // (2) the same round trip for a session tiny created itself: no transcript at adopt time,
    // so the cursor is still null when the turn ends
    const cwdB = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cwd-"));
    agentId = "agent-y";
    file = path.join(configDir, "projects", cwdB.replace(/[/.]/g, "-"), "agent-y.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");
    const b = manager.createSession({ profile: "local", cwd: cwdB });
    stores.sessions.patch(b.id, { agentSessionId: "agent-y" });
    expect(manager.getSession(b.id).sourceCursor).toBeNull();
    hook = () => manager.adoptSession({ profile: "local", cwd: cwdB, agentSessionId: "agent-y" });
    manager.startTurn(b.id, "from the phone");
    await manager.waitForIdle(b.id);
    manager.adoptSession({ profile: "local", cwd: cwdB, agentSessionId: "agent-y" });
    expect(stores.events.listSince(b.id, 0).map((e) => [e.type, (e.payload as { text?: string }).text]))
      .toEqual([
        ["user_message", "from the phone"],
        ["assistant_text", "done"],
      ]);
  });

  // Interrupting is a normal action with a button in the app. At that moment the transcript already
  // holds the prompt and a partial response, both of which tiny emitted natively as the turn ran
  it("advances the cursor even when the turn fails or is interrupted", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-sm-"));
    const profilesDir = path.join(home, "profiles");
    const outboxDir = path.join(home, "outbox");
    fs.mkdirSync(outboxDir, { recursive: true });
    const configDir = path.join(home, "external-claude");
    fs.mkdirSync(configDir, { recursive: true });
    addProfile(profilesDir, "local", "claude", configDir);
    const stores = createStores(openDb(":memory:"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cwd-"));
    const file = path.join(configDir, "projects", cwd.replace(/[/.]/g, "-"), "agent-f.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "from the CLI" } }) + "\n");

    // writes the prompt and a partial answer, then throws — what an interrupt looks like from here
    const throwing: AgentAdapter = {
      async runTurn(p: RunTurnParams) {
        fs.appendFileSync(file, [
          JSON.stringify({ type: "user", uuid: "t-u", message: { role: "user", content: "from the phone" } }),
          JSON.stringify({ type: "assistant", uuid: "t-a", message: { content: [{ type: "text", text: "half an" }] } }),
        ].join("\n") + "\n");
        p.emit({ type: "assistant_text", payload: { text: "half an" } });
        throw new Error("interrupted");
      },
    };
    const manager = new SessionManager({
      stores, profilesDir, adapters: { claude: throwing },
      broker: new PermissionBroker(1000),
      outbox: new FileOutbox(outboxDir, stores.files),
    });
    const { session } = manager.adoptSession({ profile: "local", cwd, agentSessionId: "agent-f" });
    expect(session.sourceCursor).toBe("u1");

    manager.startTurn(session.id, "from the phone");
    await manager.waitForIdle(session.id);
    expect(manager.getSession(session.id).status).toBe("idle");
    expect(manager.getSession(session.id).sourceCursor).toBe("t-a");

    const count = stores.events.count(session.id);
    expect(manager.syncTranscript(session.id)).toBe(0);
    expect(stores.events.count(session.id)).toBe(count);
  });

  // Only the path that actually imports events may record a stat. If advanceCursor recorded one it
  // would mark the file "consumed" after reading nothing but the tail uuid, and the next real sync
  // would skip it — silently dropping genuine appended conversation
  // The stat is captured before the read on purpose, so an append landing mid-read is picked up
  // next time. But committing it when the read produced no cursor advances the stat while the
  // cursor stands still, and those records are then never imported
  it("a read that yields no cursor does not poison the stat cache", () => {
    const { manager, stores, home } = makeManager(okAdapter);
    const configDir = path.join(home, "external-claude");
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cwd-"));
    const file = path.join(configDir, "projects", cwd.replace(/[/.]/g, "-"), "agent-n.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    addProfile(path.join(home, "profiles"), "local", "claude", configDir);

    // a conversation record, and a bookkeeping line padded to its exact byte length. The first
    // state carries no message records at all, so the read comes back with no cursor
    const real = JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "from the CLI" } });
    let filler = "";
    for (let pad = 0; filler.length !== real.length; pad++) {
      filler = JSON.stringify({ type: "mode", pad: "x".repeat(pad) });
      if (filler.length > real.length) throw new Error("cannot pad to the same length");
    }
    const t = new Date(1_700_000_000_000);
    fs.writeFileSync(file, filler + "\n");
    fs.utimesSync(file, t, t);

    const { session } = manager.adoptSession({ profile: "local", cwd, agentSessionId: "agent-n" });
    expect(stores.events.count(session.id)).toBe(0);
    expect(session.sourceCursor).toBeNull();

    // the real record lands in a file of identical size and mtime: only a stat committed by that
    // cursorless read could make this one skip
    fs.writeFileSync(file, real + "\n");
    fs.utimesSync(file, t, t);
    expect(manager.syncTranscript(session.id)).toBe(1);
    expect(manager.getSession(session.id).sourceCursor).toBe("u1");
  });

  it("advanceCursor does not mark the transcript as read", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-sm-"));
    const profilesDir = path.join(home, "profiles");
    const outboxDir = path.join(home, "outbox");
    fs.mkdirSync(outboxDir, { recursive: true });
    const configDir = path.join(home, "external-claude");
    fs.mkdirSync(configDir, { recursive: true });
    addProfile(profilesDir, "local", "claude", configDir);
    const stores = createStores(openDb(":memory:"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cwd-"));
    const file = path.join(configDir, "projects", cwd.replace(/[/.]/g, "-"), "agent-c.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });

    // a record the CLI adds later, and a bookkeeping line padded to its exact byte length, so the
    // two file states are indistinguishable by size — only the recorded stat decides
    const later = JSON.stringify({ type: "user", uuid: "c1", message: { role: "user", content: "from the CLI, later" } });
    let filler = "";
    for (let pad = 0; filler.length !== later.length; pad++) {
      filler = JSON.stringify({ type: "mode", pad: "x".repeat(pad) });
      if (filler.length > later.length) throw new Error("cannot pad to the same length");
    }
    const t = new Date(1_700_000_000_000);
    fs.writeFileSync(file, JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "from the CLI" } }) + "\n");

    const writesThenStamps: AgentAdapter = {
      async runTurn(p: RunTurnParams) {
        p.emit({ type: "assistant_text", payload: { text: "done" } });
        fs.appendFileSync(file, [
          JSON.stringify({ type: "user", uuid: "t-u", message: { role: "user", content: "from the phone" } }),
          JSON.stringify({ type: "assistant", uuid: "t-a", message: { content: [{ type: "text", text: "done" }] } }),
          filler,
        ].join("\n") + "\n");
        // fixed timestamp, so the stat advanceCursor sees and the one after the swap agree exactly
        fs.utimesSync(file, t, t);
        return { agentSessionId: "agent-c", costUsd: null, resultText: "ok" };
      },
    };
    const manager = new SessionManager({
      stores, profilesDir, adapters: { claude: writesThenStamps },
      broker: new PermissionBroker(1000),
      outbox: new FileOutbox(outboxDir, stores.files),
    });
    const { session } = manager.adoptSession({ profile: "local", cwd, agentSessionId: "agent-c" });
    manager.startTurn(session.id, "from the phone");
    await manager.waitForIdle(session.id);
    expect(manager.getSession(session.id).sourceCursor).toBe("t-a");

    // the CLI's next line lands in a file of identical size and mtime
    fs.writeFileSync(file, [
      JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "from the CLI" } }),
      JSON.stringify({ type: "user", uuid: "t-u", message: { role: "user", content: "from the phone" } }),
      JSON.stringify({ type: "assistant", uuid: "t-a", message: { content: [{ type: "text", text: "done" }] } }),
      later,
    ].join("\n") + "\n");
    fs.utimesSync(file, t, t);

    // only the import path may have recorded a stat, so this must still be read
    expect(manager.syncTranscript(session.id)).toBe(1);
    expect(stores.events.listSince(session.id, 0).at(-1)!.payload).toEqual({ text: "from the CLI, later" });
  });

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

  it("cliSessionEnded imports the transcript before judging the session empty", () => {
    const { manager, stores, home } = makeManager(okAdapter);
    const configDir = path.join(home, "external-claude");
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cwd-"));
    const file = path.join(configDir, "projects", cwd.replace(/[/.]/g, "-"), "agent-late.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    addProfile(path.join(home, "profiles"), "local", "claude", configDir);

    // SessionStart fires before the user has typed anything: the transcript is still empty
    const { session } = manager.adoptSession({ profile: "local", cwd, agentSessionId: "agent-late" });
    expect(stores.events.count(session.id)).toBe(0);
    expect(manager.getSession(session.id).title).toBeNull();

    // the turn runs and the CLI writes it out; nothing has asked tiny to sync
    fs.writeFileSync(file, [
      JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "what does this repo do" } }),
      JSON.stringify({ type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "it drives agents" }] } }),
    ].join("\n") + "\n");

    // SessionEnd must not throw away a session that held a real exchange; it is closed instead
    expect(manager.cliSessionEnded("agent-late")).toEqual({ discarded: false, closed: true });
    expect(stores.sessions.get(session.id)).not.toBeNull();
    expect(stores.events.listSince(session.id, 0).map((e) => e.type))
      .toEqual(["user_message", "assistant_text"]);
    // the title fallback rides along with the import
    expect(manager.getSession(session.id).title).toBe("what does this repo do");
  });

  it("cliSessionEnded keeps (and closes) a session whose import was skipped because it is running", () => {
    const { manager, stores, home } = makeManager(okAdapter);
    const configDir = path.join(home, "external-claude");
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cwd-"));
    const file = path.join(configDir, "projects", cwd.replace(/[/.]/g, "-"), "agent-busy.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    addProfile(path.join(home, "profiles"), "local", "claude", configDir);
    const { session } = manager.adoptSession({ profile: "local", cwd, agentSessionId: "agent-busy" });
    fs.writeFileSync(file, JSON.stringify({
      type: "user", uuid: "u1", message: { role: "user", content: "mid-turn" },
    }) + "\n");
    stores.sessions.patch(session.id, { status: "running" });

    // syncTranscript declines to import mid-turn; deleting on the strength of a look we did not
    // take would be the same bug in a new place
    expect(manager.cliSessionEnded("agent-busy")).toEqual({ discarded: false, closed: true });
    expect(stores.sessions.get(session.id)).not.toBeNull();
    expect(stores.sessions.get(session.id)!.cliClosedAt).not.toBeNull();
  });

  it("cliSessionEnded removes a session with no events", () => {
    const { manager, stores, home } = makeManager(okAdapter);
    const configDir = path.join(home, "external-claude");
    fs.mkdirSync(configDir, { recursive: true });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cwd-"));
    addProfile(path.join(home, "profiles"), "local", "claude", configDir);
    const { session } = manager.adoptSession({ profile: "local", cwd, agentSessionId: "agent-empty" });
    expect(stores.events.count(session.id)).toBe(0);
    expect(manager.cliSessionEnded("agent-empty")).toEqual({ discarded: true, closed: false });
    expect(stores.sessions.get(session.id)).toBeNull();
    // unknown id is a no-op
    expect(manager.cliSessionEnded("agent-empty")).toEqual({ discarded: false, closed: false });
  });

  it("cliSessionEnded marks a kept session closed without moving it in the list", () => {
    const { manager, stores, home } = makeManager(okAdapter);
    const configDir = path.join(home, "external-claude");
    fs.mkdirSync(configDir, { recursive: true });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cwd-"));
    addProfile(path.join(home, "profiles"), "local", "claude", configDir);
    const { session } = manager.adoptSession({ profile: "local", cwd, agentSessionId: "agent-kept" });
    stores.events.append(session.id, "user_message", { text: "hi" });
    const before = stores.sessions.get(session.id)!.updatedAt;

    expect(manager.cliSessionEnded("agent-kept")).toEqual({ discarded: false, closed: true });
    const after = stores.sessions.get(session.id)!;
    expect(after.cliClosedAt).not.toBeNull();
    expect(after.status).toBe("idle");
    expect(after.updatedAt).toBe(before);
  });

  it("the Closed mark goes away when attach starts, the CLI resumes, or the phone sends", async () => {
    const { manager, stores, home } = makeManager(okAdapter);
    const configDir = path.join(home, "external-claude");
    fs.mkdirSync(configDir, { recursive: true });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cwd-"));
    addProfile(path.join(home, "profiles"), "local", "claude", configDir);
    const { session } = manager.adoptSession({ profile: "local", cwd, agentSessionId: "agent-r" });
    stores.events.append(session.id, "user_message", { text: "hi" });
    const closedAt = () => stores.sessions.get(session.id)!.cliClosedAt;

    // `tiny attach` takes it into a terminal again
    manager.cliSessionEnded("agent-r");
    expect(closedAt()).not.toBeNull();
    manager.setDetached(session.id, true);
    expect(closedAt()).toBeNull();
    manager.setDetached(session.id, false);

    // `claude --resume` on the Mac: the SessionStart hook adopts the same session again
    manager.cliSessionEnded("agent-r");
    manager.adoptSession({ profile: "local", cwd, agentSessionId: "agent-r" });
    expect(closedAt()).toBeNull();

    // a message from the phone: the session is tiny's again (last — the adapter renames agentSessionId)
    manager.cliSessionEnded("agent-r");
    expect(closedAt()).not.toBeNull();
    manager.startTurn(session.id, "again");
    expect(closedAt()).toBeNull();
    await manager.waitForIdle(session.id);
    expect(closedAt()).toBeNull();
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

  /** An adapter whose turns only finish when the test lets them, recording every prompt it saw */
  function gatedAdapter(): { adapter: AgentAdapter; prompts: string[]; releaseAll: () => void } {
    const prompts: string[] = [];
    const gates: Array<() => void> = [];
    let open = false;   // once released, later turns run straight through
    return {
      prompts,
      releaseAll: () => { open = true; for (const g of gates.splice(0)) g(); },
      adapter: {
        async runTurn(p) {
          prompts.push(p.prompt);
          p.emit({ type: "turn_started", payload: {} });
          await new Promise<void>((r) => (open ? r() : gates.push(r)));
          p.emit({ type: "turn_completed", payload: {} });
          return { agentSessionId: "agent-1", costUsd: null, resultText: null };
        },
      },
    };
  }

  // Typing during a turn queues in Claude Code's own CLI; refusing it here made the phone the
  // odd one out (device report: "tiny can't queue, it just errors")
  it("queues a message sent during a turn and runs it when the turn ends, in order", async () => {
    const { adapter, prompts, releaseAll } = gatedAdapter();
    const { manager, stores } = makeManager(adapter);
    const s = manager.createSession({ profile: "work", cwd });
    expect(manager.startTurn(s.id, "a")).toEqual({ queued: false });
    expect(manager.startTurn(s.id, "b")).toEqual({ queued: true });
    expect(manager.startTurn(s.id, "c")).toEqual({ queued: true });
    // The queued messages are in the conversation immediately — the person can see what they sent
    expect(stores.events.listSince(s.id, 0).filter((e) => e.type === "user_message").map((e) => e.payload.text))
      .toEqual(["a", "b", "c"]);
    expect(prompts).toEqual(["a"]);
    releaseAll();
    await manager.waitForIdle(s.id);
    expect(prompts).toEqual(["a", "b", "c"]);
    expect(manager.getSession(s.id).status).toBe("idle");
  });

  it("still refuses a turn while the CLI has the session attached", async () => {
    const { manager } = makeManager(okAdapter);
    const s = manager.createSession({ profile: "work", cwd });
    manager.setDetached(s.id, true);
    expect(() => manager.startTurn(s.id, "c")).toThrow(ConflictError);
    manager.setDetached(s.id, false);
    expect(manager.getSession(s.id).status).toBe("idle");
  });

  // A phone can send faster than turns finish; an unbounded queue would hold messages the person
  // has long forgotten about
  it("caps the queue and says so", async () => {
    const { adapter, releaseAll } = gatedAdapter();
    const { manager } = makeManager(adapter);
    const s = manager.createSession({ profile: "work", cwd });
    manager.startTurn(s.id, "running");
    for (let i = 0; i < SessionManager.MAX_QUEUED; i++) manager.startTurn(s.id, `q${i}`);
    expect(() => manager.startTurn(s.id, "one too many")).toThrow(/queued/i);
    releaseAll();
    await manager.waitForIdle(s.id);
  });

  // Stop means stop: the CLI drops what you queued too
  it("drops the queue when the turn is stopped", async () => {
    const { adapter, prompts, releaseAll } = gatedAdapter();
    const { manager } = makeManager(adapter);
    const s = manager.createSession({ profile: "work", cwd });
    manager.startTurn(s.id, "a");
    manager.startTurn(s.id, "b");
    await manager.interrupt(s.id);
    releaseAll();
    await manager.waitForIdle(s.id);
    expect(prompts).toEqual(["a"]);
    expect(manager.getSession(s.id).status).toBe("idle");
  });

  // The daemon can be killed mid-turn. The row is then marked running with nothing running, and
  // every later turn used to be refused ("A turn is already running") until tinyd restarted —
  // which is exactly the "it errors and then nothing updates any more" the device report described
  it("recovers a running status that outlived its turn instead of refusing forever", async () => {
    const { manager, stores } = makeManager(okAdapter);
    const s = manager.createSession({ profile: "work", cwd });
    stores.sessions.patch(s.id, { status: "running" });
    expect(manager.startTurn(s.id, "hello")).toEqual({ queued: false });
    await manager.waitForIdle(s.id);
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

  describe("SessionManager live turns (CLI holds the session)", () => {
    it("sends the turn to the CLI instead of 409, then completes from what the CLI writes", async () => {
      const { peer, sent, modeCalls, setStatus } = fakePeer();
      const { manager, stores, home } = makeManager(okAdapter, { deps: { isCliLive: () => true, peer, liveTiming: FAST_LIVE } });
      const { session, file } = liveSession(manager, home, "agent-live");
      const seen: EventRecord[] = [];
      manager.on("event", (e) => seen.push(e));

      manager.startTurn(session.id, "hello from the phone");
      expect(stores.sessions.get(session.id)!.status).toBe("running");
      await until(() => sent.length === 1);
      expect(sent[0]!.agentSessionId).toBe("agent-live");
      expect(sent[0]!.content).toMatch(/^<cross-session-message from-name="tiny" from-mode="prompting">\nhello from the phone\n/);
      // mode() must be called with the resolved target, not just the session — this is how the
      // server picks up readProcessMode(target.pid) when the transcript does not exist yet
      expect(modeCalls).toContainEqual({ pid: 4242, sockPath: "/srv/cc-socks/4242.sock" });

      // the CLI runs it: registry goes busy, the transcript gets our record and the reply, then idle
      setStatus({ status: "busy", waitingFor: null });
      fs.writeFileSync(file, jsonl([peerRecord(sent[0]!.msgId), assistantRecord("hi phone")]));
      setStatus({ status: "idle", waitingFor: null });
      await manager.waitForIdle(session.id);

      expect(seen.map((e) => e.type)).toEqual(["user_message", "turn_started", "assistant_text", "turn_completed"]);
      expect(seen[0]!.payload.text).toBe("hello from the phone");
      // the reply has to ride along in the terminal event: it is what the push notification shows
      expect(seen.at(-1)!.payload).toEqual({ costUsd: null, resultText: "hi phone" });
      expect(stores.sessions.get(session.id)!.status).toBe("idle");
      // the CLI's own record of our message must not come back as a second user bubble
      expect(seen.filter((e) => e.type === "user_message")).toHaveLength(1);
    });

    it("keeps delivery/response evidence even when a concurrent syncTranscript call consumes the transcript delta first", async () => {
      // Simulates GET /v1/sessions/:id/events (polled whenever the phone has the chat open) reading
      // the delta before the watcher's own tick gets to it
      const { peer, sent, setStatus } = fakePeer();
      const { manager, home } = makeManager(okAdapter, { deps: { isCliLive: () => true, peer, liveTiming: FAST_LIVE } });
      const { session, file } = liveSession(manager, home, "agent-race");
      const seen: EventRecord[] = [];
      manager.on("event", (e) => seen.push(e));
      manager.startTurn(session.id, "hello");
      await until(() => sent.length === 1);
      setStatus({ status: "busy", waitingFor: null });
      fs.writeFileSync(file, jsonl([peerRecord(sent[0]!.msgId), assistantRecord("hi phone")]));
      manager.syncTranscript(session.id); // steals the delta before the watcher's own poll tick
      setStatus({ status: "idle", waitingFor: null });
      await manager.waitForIdle(session.id);
      expect(seen.at(-1)!.type).toBe("turn_completed");
      expect(seen.filter((e) => e.type === "assistant_text")).toHaveLength(1);
    });

    it("does not latch a response already in the transcript from before our message landed (backfill of an earlier turn)", async () => {
      const { peer, sent, setStatus } = fakePeer();
      const { manager, home } = makeManager(okAdapter, { deps: { isCliLive: () => true, peer, liveTiming: FAST_LIVE } });
      const { session, file } = liveSession(manager, home, "agent-preturn");
      fs.writeFileSync(file, jsonl([assistantRecord("earlier reply")])); // a prior turn already sits in the transcript
      const seen: EventRecord[] = [];
      manager.on("event", (e) => seen.push(e));
      manager.startTurn(session.id, "hello");
      await until(() => sent.length === 1);
      // let the watcher's own first tick backfill the earlier turn on its own, before our message lands
      await until(() => seen.some((e) => e.type === "assistant_text"));
      setStatus({ status: "busy", waitingFor: null });
      fs.appendFileSync(file, jsonl([peerRecord(sent[0]!.msgId)])); // delivered, no reply yet
      setStatus({ status: "idle", waitingFor: null });
      await new Promise((r) => setTimeout(r, FAST_LIVE.pollMs * 5));
      expect(seen.some((e) => e.type === "turn_completed")).toBe(false);
      fs.appendFileSync(file, jsonl([assistantRecord("hi phone")]));
      await manager.waitForIdle(session.id);
      expect(seen.at(-1)!.type).toBe("turn_completed");
    });

    it("does not latch a response from the CLI's own concurrent turn before our message landed", async () => {
      const { peer, sent, setStatus } = fakePeer();
      setStatus({ status: "busy", waitingFor: null }); // the CLI is mid-way through its own, unrelated turn
      const { manager, home } = makeManager(okAdapter, { deps: { isCliLive: () => true, peer, liveTiming: FAST_LIVE } });
      const { session, file } = liveSession(manager, home, "agent-concurrent");
      const seen: EventRecord[] = [];
      manager.on("event", (e) => seen.push(e));
      manager.startTurn(session.id, "hello");
      await until(() => sent.length === 1);
      fs.writeFileSync(file, jsonl([assistantRecord("cli's own reply")])); // not ours — our msg_id is not in it
      await until(() => seen.some((e) => e.type === "assistant_text")); // imported while still busy, undelivered
      // only the peer record lands now (no fresh reply of ours), and the CLI goes idle
      fs.appendFileSync(file, jsonl([peerRecord(sent[0]!.msgId)]));
      setStatus({ status: "idle", waitingFor: null });
      await new Promise((r) => setTimeout(r, FAST_LIVE.pollMs * 5));
      expect(seen.some((e) => e.type === "turn_completed")).toBe(false);
      fs.appendFileSync(file, jsonl([assistantRecord("hi phone")]));
      await manager.waitForIdle(session.id);
      expect(seen.at(-1)!.type).toBe("turn_completed");
    });

    it("completes normally, not as interrupted, when the CLI answered before ever taking the stop message", async () => {
      const { peer, sent, setStatus } = fakePeer();
      const { manager, home } = makeManager(okAdapter, { deps: { isCliLive: () => true, peer, liveTiming: FAST_LIVE } });
      const { session, file } = liveSession(manager, home, "agent-stop-after-answer");
      const seen: EventRecord[] = [];
      manager.on("event", (e) => seen.push(e));
      manager.startTurn(session.id, "hello");
      await until(() => sent.length === 1);
      setStatus({ status: "busy", waitingFor: null });
      fs.writeFileSync(file, jsonl([peerRecord(sent[0]!.msgId), assistantRecord("done already")]));
      await until(() => seen.some((e) => e.type === "assistant_text"));
      manager.interrupt(session.id);
      await until(() => sent.length === 2);
      // the CLI finished the original turn and goes idle before ever taking the stop message
      setStatus({ status: "idle", waitingFor: null });
      await manager.waitForIdle(session.id);
      expect(seen.at(-1)!.type).toBe("turn_completed");
    });

    it("ends the turn with turn_failed, without an unhandled rejection, when the session row disappears mid-turn", async () => {
      const { peer, sent, setStatus } = fakePeer();
      const { manager, stores, home } = makeManager(okAdapter, { deps: { isCliLive: () => true, peer, liveTiming: FAST_LIVE } });
      const { session } = liveSession(manager, home, "agent-deleted");
      const seen: EventRecord[] = [];
      manager.on("event", (e) => seen.push(e));
      manager.startTurn(session.id, "hello");
      await until(() => sent.length === 1);
      setStatus({ status: "busy", waitingFor: null });
      stores.sessions.delete(session.id); // the next poll tick's getSession() now throws NotFoundError
      await manager.waitForIdle(session.id); // must resolve, not reject
      expect(seen.find((e) => e.type === "turn_failed")).toBeDefined();
    });

    it("puts attached images on disk and tells the CLI where they are", async () => {
      const { peer, sent } = fakePeer();
      const { manager, home } = makeManager(okAdapter, { deps: { isCliLive: () => true, peer, liveTiming: FAST_LIVE } });
      const { session } = liveSession(manager, home, "agent-img");
      const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
      manager.startTurn(session.id, "what is this", [{ data: png, mediaType: "image/png" }]);
      await until(() => sent.length === 1);
      const m = /\[attached image: (\S+)\]/.exec(sent[0]!.content);
      expect(m).not.toBeNull();
      expect(fs.existsSync(m![1]!)).toBe(true);
      await manager.waitForIdle(session.id); // ends as turn_failed (nothing ever delivered) — that is fine here
    });

    it("fails the turn when the CLI never records the message while idle (dropped as duplicate / rate-limited)", async () => {
      const { peer } = fakePeer();
      const { manager, stores, home } = makeManager(okAdapter, { deps: { isCliLive: () => true, peer, liveTiming: FAST_LIVE } });
      const { session } = liveSession(manager, home, "agent-drop");
      const seen: EventRecord[] = [];
      manager.on("event", (e) => seen.push(e));
      manager.startTurn(session.id, "hello");
      await manager.waitForIdle(session.id);
      const failed = seen.find((e) => e.type === "turn_failed");
      expect(failed?.payload.error).toMatch(/dropped/);
      expect(stores.sessions.get(session.id)!.status).toBe("idle");
    });

    it("keeps waiting while the CLI is busy with its own turn — the message is queued, not dropped", async () => {
      const { peer, sent, setStatus } = fakePeer();
      setStatus({ status: "busy", waitingFor: null });
      const { manager, home } = makeManager(okAdapter, { deps: { isCliLive: () => true, peer, liveTiming: FAST_LIVE } });
      const { session, file } = liveSession(manager, home, "agent-queued");
      const seen: EventRecord[] = [];
      manager.on("event", (e) => seen.push(e));
      manager.startTurn(session.id, "hello");
      await until(() => sent.length === 1);
      await new Promise((r) => setTimeout(r, FAST_LIVE.deliveryTimeoutMs * 2)); // well past the idle-only timeout
      expect(seen.some((e) => e.type === "turn_failed")).toBe(false);
      fs.writeFileSync(file, jsonl([assistantRecord("cli own work"), peerRecord(sent[0]!.msgId), assistantRecord("late reply")]));
      setStatus({ status: "idle", waitingFor: null });
      await manager.waitForIdle(session.id);
      expect(seen.at(-1)!.type).toBe("turn_completed");
      // the push preview is the reply that followed our message, not the CLI's own earlier text
      expect(seen.at(-1)!.payload.resultText).toBe("late reply");
    });

    it("never carries text from the CLI's own concurrent turn into the completed turn's reply", async () => {
      // Our message is answered by tool use alone, so the only assistant text in the transcript is
      // the CLI's own earlier turn. That text belongs to nobody on the phone: resultText stays null
      const { peer, sent, setStatus } = fakePeer();
      setStatus({ status: "busy", waitingFor: null }); // the CLI is mid-way through its own work
      const { manager, home } = makeManager(okAdapter, { deps: { isCliLive: () => true, peer, liveTiming: FAST_LIVE } });
      const { session, file } = liveSession(manager, home, "agent-own-text");
      const seen: EventRecord[] = [];
      manager.on("event", (e) => seen.push(e));
      manager.startTurn(session.id, "hello");
      await until(() => sent.length === 1);
      fs.writeFileSync(file, jsonl([assistantRecord("cli own work")]));
      await until(() => seen.some((e) => e.type === "assistant_text")); // imported while still undelivered
      fs.appendFileSync(file, jsonl([peerRecord(sent[0]!.msgId), toolRecord()]));
      setStatus({ status: "idle", waitingFor: null });
      await manager.waitForIdle(session.id);
      expect(seen.at(-1)!.type).toBe("turn_completed");
      expect(seen.at(-1)!.payload.resultText).toBeNull();
    });

    it("times out a message held for review (status stays 'waiting', not idle) instead of hanging for the full turn", async () => {
      // A fresh bypass session with no transcript yet holds an unattested message and reports
      // status: "waiting" the same as a real permission prompt — this must not be mistaken for
      // "the CLI is busy with its own turn" (which does not count toward the delivery timeout)
      const { peer, sent, setStatus } = fakePeer();
      setStatus({ status: "waiting", waitingFor: "permission prompt" });
      const { manager, stores, home } = makeManager(okAdapter, { deps: { isCliLive: () => true, peer, liveTiming: FAST_LIVE } });
      const { session } = liveSession(manager, home, "agent-held");
      const seen: EventRecord[] = [];
      manager.on("event", (e) => seen.push(e));
      manager.startTurn(session.id, "hello");
      await until(() => sent.length === 1);
      await manager.waitForIdle(session.id);
      const failed = seen.find((e) => e.type === "turn_failed");
      expect(failed?.payload.error).toMatch(/dropped|held/);
      expect(seen.filter((e) => e.type === "cli_attention")).toHaveLength(1);
      expect(stores.sessions.get(session.id)!.status).toBe("idle");
    });

    it("fails the turn when the CLI goes away mid-turn", async () => {
      const { peer, sent, setStatus } = fakePeer();
      const { manager, home } = makeManager(okAdapter, { deps: { isCliLive: () => true, peer, liveTiming: FAST_LIVE } });
      const { session } = liveSession(manager, home, "agent-gone");
      const seen: EventRecord[] = [];
      manager.on("event", (e) => seen.push(e));
      manager.startTurn(session.id, "hello");
      await until(() => sent.length === 1);
      setStatus(null);
      await manager.waitForIdle(session.id);
      expect(seen.find((e) => e.type === "turn_failed")?.payload.error).toMatch(/CLI closed/);
    });

    it("fails immediately, without turn_started, when the socket cannot be written", async () => {
      const { peer } = fakePeer({ send: async () => { throw new Error("connect ENOENT /srv/cc-socks/4242.sock"); } });
      const { manager, stores, home } = makeManager(okAdapter, { deps: { isCliLive: () => true, peer, liveTiming: FAST_LIVE } });
      const { session } = liveSession(manager, home, "agent-nosock");
      const seen: EventRecord[] = [];
      manager.on("event", (e) => seen.push(e));
      manager.startTurn(session.id, "hello");
      await manager.waitForIdle(session.id);
      expect(seen.map((e) => e.type)).toEqual(["user_message", "turn_failed"]);
      expect(seen[1]!.payload.error).toMatch(/could not reach the CLI/);
      expect(stores.sessions.get(session.id)!.status).toBe("idle");
    });

    it("reports the CLI waiting for its user once per wait, as cli_attention", async () => {
      const { peer, sent, setStatus } = fakePeer();
      const { manager, home } = makeManager(okAdapter, { deps: { isCliLive: () => true, peer, liveTiming: FAST_LIVE } });
      const { session, file } = liveSession(manager, home, "agent-wait");
      const seen: EventRecord[] = [];
      manager.on("event", (e) => seen.push(e));
      manager.startTurn(session.id, "run the tests");
      await until(() => sent.length === 1);
      setStatus({ status: "busy", waitingFor: null });
      fs.writeFileSync(file, jsonl([peerRecord(sent[0]!.msgId)]));
      await until(() => seen.some((e) => e.type === "turn_started"));
      setStatus({ status: "waiting", waitingFor: "permission prompt" });
      await until(() => seen.some((e) => e.type === "cli_attention"));
      await new Promise((r) => setTimeout(r, FAST_LIVE.pollMs * 5)); // still waiting: must not repeat
      setStatus({ status: "busy", waitingFor: null });
      fs.appendFileSync(file, jsonl([assistantRecord("tests pass")]));
      setStatus({ status: "idle", waitingFor: null });
      await manager.waitForIdle(session.id);
      const attention = seen.filter((e) => e.type === "cli_attention");
      expect(attention).toHaveLength(1);
      expect(attention[0]!.payload.reason).toBe("permission prompt");
      expect(seen.at(-1)!.type).toBe("turn_completed");
    });

    it("Stop sends a 'now' message that makes the CLI abandon the turn, and the turn ends as interrupted", async () => {
      const { peer, sent, setStatus } = fakePeer();
      const { manager, home } = makeManager(okAdapter, { deps: { isCliLive: () => true, peer, liveTiming: FAST_LIVE } });
      const { session, file } = liveSession(manager, home, "agent-stop");
      const seen: EventRecord[] = [];
      manager.on("event", (e) => seen.push(e));
      manager.startTurn(session.id, "count to a million");
      await until(() => sent.length === 1);
      setStatus({ status: "busy", waitingFor: null });
      fs.writeFileSync(file, jsonl([peerRecord(sent[0]!.msgId), assistantRecord("1\n2\n3")]));
      await until(() => seen.some((e) => e.type === "assistant_text"));

      manager.interrupt(session.id);
      await until(() => sent.length === 2);
      expect(sent[1]!.priority).toBe("now");
      expect(sent[1]!.content).toContain("pressed Stop");
      manager.interrupt(session.id); // a second tap while stopping does not send twice
      expect(sent).toHaveLength(2);

      // the CLI takes the stop message, answers in one line, goes idle
      fs.appendFileSync(file, jsonl([peerRecord(sent[1]!.msgId), assistantRecord("Stopped.")]));
      setStatus({ status: "idle", waitingFor: null });
      await manager.waitForIdle(session.id);
      expect(seen.at(-1)).toMatchObject({ type: "turn_failed", payload: { error: "interrupted" } });
    });

    it("Stop on a turn the CLI has not taken yet still ends the turn once the stop message lands", async () => {
      const { peer, sent, setStatus } = fakePeer();
      setStatus({ status: "busy", waitingFor: null }); // the CLI is busy with its own work; ours is queued
      const { manager, home } = makeManager(okAdapter, { deps: { isCliLive: () => true, peer, liveTiming: FAST_LIVE } });
      const { session, file } = liveSession(manager, home, "agent-stop-queued");
      const seen: EventRecord[] = [];
      manager.on("event", (e) => seen.push(e));
      manager.startTurn(session.id, "hello");
      await until(() => sent.length === 1);
      manager.interrupt(session.id);
      await until(() => sent.length === 2);
      fs.writeFileSync(file, jsonl([peerRecord(sent[1]!.msgId), assistantRecord("Stopped.")]));
      setStatus({ status: "idle", waitingFor: null });
      await manager.waitForIdle(session.id);
      expect(seen.at(-1)).toMatchObject({ type: "turn_failed", payload: { error: "interrupted" } });
    });

    it("reports the same wait once even when the registry entry is caught mid-write in between", async () => {
      // status "unknown" means "could not read the entry this tick", not "the CLI changed state".
      // Letting it land in lastStatus would make the next readable tick look like a fresh wait
      const { peer, sent, setStatus } = fakePeer();
      const { manager, home } = makeManager(okAdapter, { deps: { isCliLive: () => true, peer, liveTiming: FAST_LIVE } });
      const { session, file } = liveSession(manager, home, "agent-unknown-attention");
      const seen: EventRecord[] = [];
      manager.on("event", (e) => seen.push(e));
      manager.startTurn(session.id, "run the tests");
      await until(() => sent.length === 1);
      setStatus({ status: "busy", waitingFor: null });
      fs.writeFileSync(file, jsonl([peerRecord(sent[0]!.msgId)]));
      await new Promise((r) => setTimeout(r, FAST_LIVE.pollMs * 5)); // let the watcher import the delivery
      setStatus({ status: "waiting", waitingFor: "permission prompt" });
      await until(() => seen.some((e) => e.type === "cli_attention"));
      setStatus({ status: "unknown", waitingFor: null });
      await new Promise((r) => setTimeout(r, FAST_LIVE.pollMs * 5));
      setStatus({ status: "waiting", waitingFor: "permission prompt" }); // the same wait, still unanswered
      await new Promise((r) => setTimeout(r, FAST_LIVE.pollMs * 5));
      expect(seen.filter((e) => e.type === "cli_attention")).toHaveLength(1);
      setStatus({ status: "busy", waitingFor: null });
      fs.appendFileSync(file, jsonl([assistantRecord("tests pass")]));
      setStatus({ status: "idle", waitingFor: null });
      await manager.waitForIdle(session.id);
      expect(seen.at(-1)!.type).toBe("turn_completed");
    });

    it("does not let a registry entry caught mid-write postpone the delivery timeout", async () => {
      // Every other tick is unreadable. Counting those as "not idle" would restart the clock
      // forever and hide a message the CLI never took behind the 30-minute backstop
      let ticks = 0;
      const { peer } = fakePeer({
        status: () => (++ticks % 2 === 0 ? { status: "unknown", waitingFor: null } : { status: "idle", waitingFor: null }),
      });
      const { manager, home } = makeManager(okAdapter, { deps: { isCliLive: () => true, peer, liveTiming: FAST_LIVE } });
      const { session } = liveSession(manager, home, "agent-unknown-timeout");
      const seen: EventRecord[] = [];
      manager.on("event", (e) => seen.push(e));
      manager.startTurn(session.id, "hello");
      await manager.waitForIdle(session.id);
      expect(seen.at(-1)!.payload.error).toMatch(/dropped/);
    });

    it("never gives up on a busy CLI — however long it works — and completes once it goes idle", async () => {
      const { peer, sent, setStatus } = fakePeer();
      setStatus({ status: "busy", waitingFor: null, since: Date.now() });
      const { manager, stores, home } = makeManager(okAdapter, { deps: { isCliLive: () => true, peer, liveTiming: FAST_LIVE } });
      const { session, file } = liveSession(manager, home, "agent-long");
      const seen: EventRecord[] = [];
      manager.on("event", (e) => seen.push(e));
      manager.startTurn(session.id, "hello");
      await until(() => sent.length === 1);
      fs.writeFileSync(file, jsonl([peerRecord(sent[0]!.msgId)])); // taken; the CLI is now working on it
      // Far past every other clock (delivery timeout, settle time): still running, because busy is busy
      await new Promise((r) => setTimeout(r, FAST_LIVE.deliveryTimeoutMs * 3));
      expect(seen.some((e) => e.type === "turn_failed" || e.type === "turn_completed")).toBe(false);
      expect(stores.sessions.get(session.id)!.status).toBe("running");
      fs.appendFileSync(file, jsonl([assistantRecord("finally")]));
      setStatus({ status: "idle", waitingFor: null, since: Date.now() });
      await manager.waitForIdle(session.id);
      expect(seen.at(-1)).toMatchObject({ type: "turn_completed", payload: { resultText: "finally" } });
    });

    it("completes when the CLI goes idle after taking the message, even with no visible reply", async () => {
      // The registry's own clock puts the idle after our delivery, so the turn is over whatever the
      // transcript showed (a reply written to a file tiny cannot see, or none at all)
      const { peer, sent, setStatus } = fakePeer();
      setStatus({ status: "busy", waitingFor: null, since: Date.now() });
      const { manager, home } = makeManager(okAdapter, { deps: { isCliLive: () => true, peer, liveTiming: FAST_LIVE } });
      const { session, file } = liveSession(manager, home, "agent-silent");
      const seen: EventRecord[] = [];
      manager.on("event", (e) => seen.push(e));
      manager.startTurn(session.id, "hello");
      await until(() => sent.length === 1);
      fs.writeFileSync(file, jsonl([peerRecord(sent[0]!.msgId)]));
      await new Promise((r) => setTimeout(r, FAST_LIVE.pollMs * 3)); // let the watcher notice the delivery
      setStatus({ status: "idle", waitingFor: null, since: Date.now() });
      await manager.waitForIdle(session.id);
      expect(seen.at(-1)).toEqual(expect.objectContaining({ type: "turn_completed", payload: { costUsd: null, resultText: null } }));
    });

    it("does not take an idle reading older than the delivery for the end of the turn until it has settled", async () => {
      const { peer, sent, setStatus } = fakePeer();
      const stale = Date.now() - 60_000;
      setStatus({ status: "idle", waitingFor: null, since: stale }); // never updated: the CLI's clock says nothing new
      const { manager, home } = makeManager(okAdapter, { deps: { isCliLive: () => true, peer, liveTiming: FAST_LIVE } });
      const { session, file } = liveSession(manager, home, "agent-stale");
      const seen: EventRecord[] = [];
      manager.on("event", (e) => seen.push(e));
      manager.startTurn(session.id, "hello");
      await until(() => sent.length === 1);
      fs.writeFileSync(file, jsonl([peerRecord(sent[0]!.msgId)]));
      await until(() => seen.some((e) => e.type === "turn_started"));
      const deliveredAt = Date.now();
      await manager.waitForIdle(session.id);
      // it did end — by the settle clock, not on the first idle tick
      expect(seen.at(-1)!.type).toBe("turn_completed");
      expect(Date.now() - deliveredAt).toBeGreaterThanOrEqual(FAST_LIVE.idleSettleMs - FAST_LIVE.pollMs);
    });

    it("fails the turn when the registry entry stays unreadable", async () => {
      const { peer, sent, setStatus } = fakePeer();
      setStatus({ status: "unknown", waitingFor: null });
      const { manager, stores, home } = makeManager(okAdapter, { deps: { isCliLive: () => true, peer, liveTiming: FAST_LIVE } });
      const { session } = liveSession(manager, home, "agent-unreadable");
      const seen: EventRecord[] = [];
      manager.on("event", (e) => seen.push(e));
      manager.startTurn(session.id, "hello");
      await until(() => sent.length === 1);
      await manager.waitForIdle(session.id);
      expect(seen.at(-1)).toMatchObject({ type: "turn_failed", payload: { error: "the CLI's state could not be read" } });
      expect(stores.sessions.get(session.id)!.status).toBe("idle");
    });

    it("fails the turn when the Stop message cannot be delivered, instead of leaving it running silently", async () => {
      // The socket is gone by the time Stop is tapped. Without a terminal event the phone would
      // keep showing a running turn until the 30-minute backstop
      const frames: PeerFrame[] = [];
      const { peer, setStatus } = fakePeer({
        send: async (_s, _t, frame) => {
          frames.push(frame);
          if (frame.priority === "now") throw new Error("connect ENOENT /srv/cc-socks/4242.sock");
        },
      });
      setStatus({ status: "busy", waitingFor: null }); // the CLI is working: nothing else would end the turn
      const { manager, stores, home } = makeManager(okAdapter, { deps: { isCliLive: () => true, peer, liveTiming: FAST_LIVE } });
      const { session } = liveSession(manager, home, "agent-stop-unreachable");
      const seen: EventRecord[] = [];
      manager.on("event", (e) => seen.push(e));
      manager.startTurn(session.id, "count to a million");
      await until(() => frames.length === 1);
      manager.interrupt(session.id);
      await manager.waitForIdle(session.id);
      expect(seen.at(-1)!.type).toBe("turn_failed");
      expect(seen.at(-1)!.payload.error).toMatch(/could not stop the CLI/);
      expect(stores.sessions.get(session.id)!.status).toBe("idle");
    });

    // A question the CLI asks (AskUserQuestion) can only be answered by the CLI itself. The phone
    // answers it by having the CLI abandon its own prompt and take the answers as a message
    describe("answering a question the CLI asked", () => {
      function questionRecords(toolUseId: string) {
        return [
          {
            type: "assistant", uuid: `q-${toolUseId}`,
            message: { content: [{ type: "tool_use", id: toolUseId, name: "AskUserQuestion",
              input: { questions: [{ question: "Which goal?", header: "Goal", multiSelect: false,
                options: [{ label: "staging", description: "" }] }] } }] },
          },
        ];
      }

      /** The record Claude Code writes once the injected answer cancelled its question prompt */
      function rejectedRecord(toolUseId: string): Record<string, unknown> {
        return {
          type: "user", uuid: `r-${toolUseId}`,
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: true,
            content: "The user doesn't want to proceed with this tool use." }] },
          toolUseResult: "User rejected tool use",
        };
      }

      it("sends the answers into the CLI with priority now and keeps them in history", async () => {
        const { peer, sent, setStatus } = fakePeer();
        const { manager, home } = makeManager(okAdapter, { deps: { isCliLive: () => true, peer, liveTiming: FAST_LIVE } });
        const { session, file } = liveSession(manager, home, "agent-q");
        fs.writeFileSync(file, jsonl(questionRecords("tu-1")));
        manager.syncTranscript(session.id);
        const seen: EventRecord[] = [];
        manager.on("event", (e) => seen.push(e));

        await manager.answerCliQuestion(session.id, "tu-1", { "Which goal?": "staging" });
        await until(() => sent.length === 1);
        expect(sent[0]!.priority).toBe("now");
        expect(sent[0]!.content).toContain("Which goal?");
        expect(sent[0]!.content).toContain("staging");
        // The answer is in the conversation as the question's answer, not as a message the person typed
        const answered = seen.find((e) => e.type === "cli_question_answered");
        expect(answered!.payload).toEqual({ toolUseId: "tu-1", answers: { "Which goal?": "staging" } });
        expect(seen.some((e) => e.type === "user_message")).toBe(false);
        expect(seen.some((e) => e.type === "turn_started")).toBe(true);

        // The CLI records the cancelled prompt as a rejection. That echo must not land on top of
        // the answer card as "Dismissed in the CLI"
        setStatus({ status: "busy", waitingFor: null });
        fs.appendFileSync(file, jsonl([rejectedRecord("tu-1"), peerRecord(sent[0]!.msgId), assistantRecord("going with staging")]));
        setStatus({ status: "idle", waitingFor: null });
        await manager.waitForIdle(session.id);
        expect(seen.filter((e) => e.type === "cli_question_answered")).toHaveLength(1);
        expect(seen.at(-1)!.type).toBe("turn_completed");
      });

      it("delivers into the live turn that asked, without starting a second one", async () => {
        const { peer, sent, setStatus } = fakePeer();
        const { manager, home } = makeManager(okAdapter, { deps: { isCliLive: () => true, peer, liveTiming: FAST_LIVE } });
        const { session, file } = liveSession(manager, home, "agent-q-live");
        const seen: EventRecord[] = [];
        manager.on("event", (e) => seen.push(e));
        manager.startTurn(session.id, "plan the release");
        await until(() => sent.length === 1);
        setStatus({ status: "busy", waitingFor: null });
        fs.writeFileSync(file, jsonl([peerRecord(sent[0]!.msgId), ...questionRecords("tu-2")]));
        await until(() => seen.some((e) => e.type === "cli_question"));
        setStatus({ status: "waiting", waitingFor: "question" });

        await manager.answerCliQuestion(session.id, "tu-2", { "Which goal?": "staging" });
        expect(sent).toHaveLength(2);
        expect(sent[1]!.priority).toBe("now");
        // One turn, one turn_started: the answer rides the turn that asked
        expect(seen.filter((e) => e.type === "turn_started")).toHaveLength(1);
        setStatus({ status: "busy", waitingFor: null });
        fs.appendFileSync(file, jsonl([rejectedRecord("tu-2"), assistantRecord("going with staging")]));
        setStatus({ status: "idle", waitingFor: null });
        await manager.waitForIdle(session.id);
        expect(seen.filter((e) => e.type === "cli_question_answered")).toHaveLength(1);
      });

      it("does not show the cancelled prompt as a dismissal when the import races the answer", async () => {
        // Device report: all three answers came out as "Dismissed in the CLI". The CLI writes its
        // rejection the instant the frame lands, and the chat's own 1.5s sync imported it before
        // the answer was recorded — so the claim has to be staked before the send, not after
        let manager!: SessionManager;
        let file = "";
        let sessionId = "";
        const frames: PeerFrame[] = [];
        const { peer, setStatus } = fakePeer({
          send: async (_s, _t, frame) => {
            frames.push(frame);
            fs.appendFileSync(file, jsonl([rejectedRecord("tu-race")]));
            manager.syncTranscript(sessionId);   // the phone has the chat open
          },
        });
        const made = makeManager(okAdapter, { deps: { isCliLive: () => true, peer, liveTiming: FAST_LIVE } });
        manager = made.manager;
        const live = liveSession(manager, made.home, "agent-race-q");
        file = live.file;
        sessionId = live.session.id;
        fs.writeFileSync(file, jsonl(questionRecords("tu-race")));
        manager.syncTranscript(sessionId);
        const seen: EventRecord[] = [];
        manager.on("event", (e) => seen.push(e));

        await manager.answerCliQuestion(sessionId, "tu-race", { "Which goal?": "staging" });
        await until(() => frames.length === 1);
        const answers = seen.filter((e) => e.type === "cli_question_answered");
        expect(answers).toHaveLength(1);
        expect(answers[0]!.payload).toEqual({ toolUseId: "tu-race", answers: { "Which goal?": "staging" } });
        setStatus({ status: "idle", waitingFor: null });
      });

      it("keeps a real dismissal visible when the answer never reached the CLI", async () => {
        const { peer } = fakePeer({ send: async () => { throw new Error("socket gone"); } });
        const { manager, home } = makeManager(okAdapter, { deps: { isCliLive: () => true, peer, liveTiming: FAST_LIVE } });
        const { session, file } = liveSession(manager, home, "agent-send-fail");
        fs.writeFileSync(file, jsonl(questionRecords("tu-fail")));
        manager.syncTranscript(session.id);
        const seen: EventRecord[] = [];
        manager.on("event", (e) => seen.push(e));

        await manager.answerCliQuestion(session.id, "tu-fail", { "Which goal?": "staging" });
        await until(() => seen.some((e) => e.type === "turn_failed"));
        // the person then dismisses the question in the terminal: that is theirs, and must show
        fs.appendFileSync(file, jsonl([rejectedRecord("tu-fail")]));
        manager.syncTranscript(session.id);
        const answers = seen.filter((e) => e.type === "cli_question_answered");
        expect(answers).toHaveLength(1);
        expect(answers[0]!.payload).toEqual({ toolUseId: "tu-fail", answers: {}, rejected: true });
      });

      it("takes the question from the hook and does not repeat it when the transcript catches up", async () => {
        // Claude Code writes an AskUserQuestion to the transcript only once it is answered, so the
        // PreToolUse hook is what puts the question on the phone while it is still on screen
        const { peer } = fakePeer();
        const { manager, home } = makeManager(okAdapter, { deps: { isCliLive: () => true, peer, liveTiming: FAST_LIVE } });
        const { session, file } = liveSession(manager, home, "agent-hook");
        const seen: EventRecord[] = [];
        manager.on("event", (e) => seen.push(e));

        const input = { questions: [{ question: "Which goal?", header: "Goal", multiSelect: false, options: [] }] };
        expect(manager.recordCliQuestion("agent-hook", "tu-9", input)).toBe(true);
        expect(seen.map((e) => e.type)).toEqual(["cli_question"]);
        expect(seen[0]!.payload).toEqual({ toolUseId: "tu-9", input });
        // the same question again (hook retried, or a second CLI) stays one question
        expect(manager.recordCliQuestion("agent-hook", "tu-9", input)).toBe(false);

        // and the transcript's own copy, which arrives once the question is answered, is not a second card
        fs.writeFileSync(file, jsonl([
          {
            type: "assistant", uuid: "q1",
            message: { content: [{ type: "tool_use", id: "tu-9", name: "AskUserQuestion", input }] },
          },
          {
            type: "user", uuid: "r1",
            message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-9" }] },
            toolUseResult: { questions: input.questions, answers: { "Which goal?": "staging" } },
          },
        ]));
        manager.syncTranscript(session.id);
        expect(seen.map((e) => e.type)).toEqual(["cli_question", "cli_question_answered"]);
        expect(seen[1]!.payload).toEqual({ toolUseId: "tu-9", answers: { "Which goal?": "staging" } });
      });

      it("closes a hook question answered in the CLI long before the transcript's first import", () => {
        // Seen on a real session: adopted at SessionStart (no transcript yet, so no cursor), the hook
        // put the question on the phone, the person answered it at the Mac, and the phone only came
        // back hours later. That first import covers the newest turns, and the answer was far behind
        // them — the card sat on the phone forever
        const { peer } = fakePeer();
        const { manager, home } = makeManager(okAdapter, { deps: { isCliLive: () => true, peer, liveTiming: FAST_LIVE } });
        const { session, file } = liveSession(manager, home, "agent-hook");
        const seen: EventRecord[] = [];
        manager.on("event", (e) => seen.push(e));

        const input = { questions: [{ question: "Which goal?", header: "Goal", multiSelect: false, options: [] }] };
        expect(manager.recordCliQuestion("agent-hook", "tu-9", input)).toBe(true);

        const later = [1, 2, 3, 4, 5, 6, 7].flatMap((n) => [
          { type: "user", uuid: `h${n}`, message: { role: "user", content: `turn ${n}` } },
          assistantRecord(`reply ${n}`),
        ]);
        fs.writeFileSync(file, jsonl([
          {
            type: "assistant", uuid: "q1",
            message: { content: [{ type: "tool_use", id: "tu-9", name: "AskUserQuestion", input }] },
          },
          {
            type: "user", uuid: "r1",
            message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-9" }] },
            toolUseResult: { questions: input.questions, answers: { "Which goal?": "staging" } },
          },
          ...later,
        ]));
        manager.syncTranscript(session.id);
        const answered = seen.filter((e) => e.type === "cli_question_answered");
        expect(answered.map((e) => e.payload)).toEqual([{ toolUseId: "tu-9", answers: { "Which goal?": "staging" } }]);
        // and it is closed for good: the next import does not answer it again
        fs.appendFileSync(file, jsonl([assistantRecord("one more")]));
        manager.syncTranscript(session.id);
        expect(seen.filter((e) => e.type === "cli_question_answered")).toHaveLength(1);
        expect(seen.filter((e) => e.type === "cli_question")).toHaveLength(1);
      });

      it("reports nothing for a session tiny does not know", () => {
        const { peer } = fakePeer();
        const { manager } = makeManager(okAdapter, { deps: { isCliLive: () => true, peer } });
        expect(manager.recordCliQuestion("nobody", "tu-1", { questions: [] })).toBe(false);
      });

      it("refuses when the CLI holding the session cannot be reached", async () => {
        const { peer } = fakePeer({ resolve: () => null });
        const { manager, home } = makeManager(okAdapter, { deps: { isCliLive: () => true, peer, liveTiming: FAST_LIVE } });
        const { session } = liveSession(manager, home, "agent-q-gone");
        await expect(manager.answerCliQuestion(session.id, "tu-3", { q: "a" })).rejects.toThrow(/not reachable/);
      });
    });

    it("still refuses with 409 when the CLI is live but cannot be joined", () => {
      const { peer } = fakePeer({ resolve: () => null });
      const { manager, home } = makeManager(okAdapter, { deps: { isCliLive: () => true, peer } });
      const { session } = liveSession(manager, home, "agent-nojoin");
      expect(() => manager.startTurn(session.id, "hello")).toThrow(/open in the CLI/);
    });

    it("canJoin is false without a peer bridge, for other agents, without an agent session id, or when the CLI is not live", () => {
      const { peer } = fakePeer();
      const none = makeManager(okAdapter, { deps: { isCliLive: () => true } });
      const a = liveSession(none.manager, none.home, "agent-a").session;
      expect(none.manager.canJoin(a)).toBe(false);

      const notLive = makeManager(okAdapter, { deps: { isCliLive: () => false, peer } });
      const b = liveSession(notLive.manager, notLive.home, "agent-b").session;
      expect(notLive.manager.canJoin(b)).toBe(false);

      const live = makeManager(okAdapter, { deps: { isCliLive: () => true, peer } });
      const c = liveSession(live.manager, live.home, "agent-c").session;
      expect(live.manager.canJoin(c)).toBe(true);
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cwd-"));
      expect(live.manager.canJoin(live.manager.createSession({ profile: "oc", cwd }))).toBe(false); // opencode
      expect(live.manager.canJoin(live.manager.createSession({ profile: "work", cwd }))).toBe(false); // no agentSessionId yet
    });
  });

  describe("observeCli (the registry as a fallback for a CLI that closed)", () => {
    const proc = (pid: number, startedAt: string | null = "2026-09-02T04:00:00.000Z"): LiveSessionEntry =>
      ({ pid, status: "idle", statusUpdatedAt: null, startedAt });

    /**
     * A session the registry deps can be driven around. `on` picks what is adopted: the default is
     * a claude session with an agent session id; `agentSessionId: null` creates one without one
     */
    function closable(
      deps: Partial<SessionManagerDeps> = {},
      adapter: AgentAdapter = okAdapter,
      on: { profile?: string; agentSessionId?: string | null } = {},
    ) {
      let live: boolean | null = null;
      let entry: LiveSessionEntry | null = null;
      const { manager, stores, home } = makeManager(adapter, {
        deps: { isCliLive: () => live, cliState: () => entry, ...deps },
      });
      const configDir = path.join(home, "external-claude");
      fs.mkdirSync(configDir, { recursive: true });
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cwd-"));
      addProfile(path.join(home, "profiles"), "local", "claude", configDir);
      const profile = on.profile ?? "local";
      const agentSessionId = on.agentSessionId === undefined ? "agent-o" : on.agentSessionId;
      const session = agentSessionId === null
        ? manager.createSession({ profile, cwd })
        : manager.adoptSession({ profile, cwd, agentSessionId }).session;
      stores.events.append(session.id, "user_message", { text: "hi" });
      const registry = (l: boolean | null, e: LiveSessionEntry | null = null): void => { live = l; entry = e; };
      const observe = () => manager.observeCli(manager.getSession(session.id));
      return { manager, stores, session, registry, observe };
    }

    it("closes a session whose CLI process was seen and is now gone", () => {
      const { registry, observe } = closable();
      registry(true, proc(100));
      expect(observe().cliClosedAt).toBeNull();
      registry(false);
      expect(observe().cliClosedAt).not.toBeNull();
    });

    it("does nothing for a session it never saw open, or while the registry cannot be read", () => {
      const { registry, observe } = closable();
      registry(false);
      expect(observe().cliClosedAt).toBeNull();   // e.g. right after a tinyd restart: the hook's job
      registry(true, proc(100));
      observe();
      registry(null);
      expect(observe().cliClosedAt).toBeNull();   // unreadable is not "gone"
      registry(false);
      expect(observe().cliClosedAt).not.toBeNull(); // the earlier sighting still counts
    });

    it("keeps the mark while the closing process is still shutting down, clears it for a new one", () => {
      const { manager, registry, observe } = closable();
      registry(true, proc(100));
      observe();
      manager.cliSessionEnded("agent-o");          // SessionEnd hook: the process is still there
      expect(observe().cliClosedAt).not.toBeNull(); // same pid = not a reopen
      registry(true, proc(101));                    // `claude --resume` in a new terminal
      expect(observe().cliClosedAt).toBeNull();
      registry(false);
      expect(observe().cliClosedAt).not.toBeNull(); // and that one closing counts again
    });

    it("ignores tiny's own SDK child, which registers like a CLI, during the turn and just after", async () => {
      const { adapter, releaseAll } = gatedAdapter();
      const { manager, session, registry, observe } = closable({}, adapter);
      manager.startTurn(session.id, "from the phone");
      // the child started after the turn did (measured: `claude -p` writes a registry entry too)
      registry(true, proc(200, new Date(Date.now() + 5).toISOString()));
      observe();
      releaseAll();
      await manager.waitForIdle(session.id);
      observe();                                     // still there for a moment after the turn
      registry(false);
      expect(observe().cliClosedAt).toBeNull();      // its going away is just the turn ending
    });

    it("does not guess about an entry without a start time while its own turn runs", async () => {
      const { adapter, releaseAll } = gatedAdapter();
      const { manager, session, registry, observe } = closable({}, adapter);
      manager.startTurn(session.id, "from the phone");
      registry(true, proc(200, null));
      observe();
      releaseAll();
      await manager.waitForIdle(session.id);
      registry(false);
      expect(observe().cliClosedAt).toBeNull();
    });

    it("after its own turn is over, a process that appears is the person's terminal", async () => {
      const { manager, session, registry, observe } = closable({ ownProcessGraceMs: 0 });
      manager.startTurn(session.id, "from the phone");
      await manager.waitForIdle(session.id);
      registry(true, proc(400, new Date().toISOString()));
      observe();
      registry(false);
      expect(observe().cliClosedAt).not.toBeNull();
    });

    // A queued message starts its turn the instant the previous one settles, and tiny's previous
    // child can still be the registry's entry for the session at that moment
    it("keeps its own-process window across back-to-back SDK turns", async () => {
      const { adapter, releaseAll } = gatedAdapter();
      const { manager, session, registry, observe } = closable({}, adapter);
      manager.startTurn(session.id, "first");
      const t1 = Date.now();
      await new Promise((r) => setTimeout(r, 5));   // so the two turns start at different times
      expect(manager.startTurn(session.id, "second")).toEqual({ queued: true });
      releaseAll();
      await manager.waitForIdle(session.id);
      // turn 1's child, started after turn 1 but before turn 2: still ours, not a terminal
      registry(true, proc(200, new Date(t1 + 1).toISOString()));
      observe();
      registry(false);
      expect(observe().cliClosedAt).toBeNull();
    });

    it("leaves codex / opencode and sessions without an agent id alone", () => {
      // opencode: the registry it would be read against is Claude Code's, so it proves nothing here
      const oc = closable({}, okAdapter, { profile: "oc", agentSessionId: "oc-1" });
      oc.registry(true, proc(100));
      oc.observe();
      oc.registry(false);
      expect(oc.observe().cliClosedAt).toBeNull();
      // claude, but tiny has no agent session id for it yet: nothing a process could be holding
      const fresh = closable({}, okAdapter, { agentSessionId: null });
      fresh.registry(true, proc(100));
      fresh.observe();
      fresh.registry(false);
      expect(fresh.observe().cliClosedAt).toBeNull();
    });
  });
});

/** Watcher timings short enough for tests: poll 10ms, give up on delivery after 200ms idle, 2s max */
const FAST_LIVE = { pollMs: 10, deliveryTimeoutMs: 200, idleSettleMs: 100 };

function fakePeer(over: Partial<PeerBridge> = {}) {
  const sent: PeerFrame[] = [];
  const modeCalls: PeerTarget[] = [];
  let status: PeerStatus | null = { status: "idle", waitingFor: null };
  const peer: PeerBridge = {
    resolve: () => ({ pid: 4242, sockPath: "/srv/cc-socks/4242.sock" }),
    status: () => status,
    mode: (_s, target) => {
      modeCalls.push(target);
      return "prompting";
    },
    send: async (_s, _t, frame) => {
      sent.push(frame);
    },
    ...over,
  };
  return { peer, sent, modeCalls, setStatus: (st: PeerStatus | null) => { status = st; } };
}

async function until(cond: () => boolean, ms = 1000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A handoff session whose CLI is live, plus the transcript path the CLI would write */
function liveSession(manager: SessionManager, home: string, agentSessionId: string) {
  const configDir = path.join(home, "external-claude");
  fs.mkdirSync(configDir, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cwd-"));
  addProfile(path.join(home, "profiles"), "local", "claude", configDir);
  const { session } = manager.adoptSession({ profile: "local", cwd, agentSessionId });
  const file = path.join(configDir, "projects", cwd.replace(/[/.]/g, "-"), `${agentSessionId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return { session, file };
}

function peerRecord(msgId: string): Record<string, unknown> {
  return {
    type: "user", uuid: `p-${msgId}`, isMeta: true, promptSource: "system",
    origin: { kind: "peer", from: "unknown", msg_id: msgId, name: "tiny" },
    message: { role: "user", content: "Another Claude session sent a message: ..." },
  };
}

function assistantRecord(text: string): Record<string, unknown> {
  return { type: "assistant", uuid: `a-${text}`, message: { content: [{ type: "text", text }] } };
}

/** A reply made of tool use only: it counts as a response, but contributes no assistant text */
function toolRecord(): Record<string, unknown> {
  return {
    type: "assistant", uuid: "t-read",
    message: { content: [{ type: "tool_use", id: "tu-read", name: "Read", input: { file_path: "notes.md" } }] },
  };
}

const jsonl = (records: Array<Record<string, unknown>>) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";

/** An assistant record carrying the API response's usage, the way Claude Code writes it */
function usageRecord(uuid: string, messageId: string, outputTokens: number): Record<string, unknown> {
  return {
    type: "assistant", uuid,
    message: { id: messageId, content: [{ type: "text", text: `reply ${uuid}` }], usage: { input_tokens: 1, output_tokens: outputTokens } },
  };
}

describe("SessionManager activity (the turn in progress, from either side)", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cwd-"));
  });

  it("is null for an idle session", () => {
    const { manager } = makeManager(okAdapter);
    const s = manager.createSession({ profile: "work", cwd });
    expect(manager.activity(s)).toBeNull();
  });

  it("reports a turn tiny runs with its start time and the adapter's output so far", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow: AgentAdapter = {
      async runTurn(p: RunTurnParams) {
        p.emit({ type: "turn_started", payload: {} });
        p.progress?.({ outputTokens: 42 });
        await gate;
        p.emit({ type: "turn_completed", payload: {} });
        return { agentSessionId: "agent-1", costUsd: null, resultText: null };
      },
    };
    const { manager } = makeManager(slow);
    const s = manager.createSession({ profile: "work", cwd });
    const before = Date.now();
    manager.startTurn(s.id, "hi");
    await until(() => manager.activity(manager.getSession(s.id))?.outputTokens === 42);
    const a = manager.activity(manager.getSession(s.id))!;
    expect(Date.parse(a.since!)).toBeGreaterThanOrEqual(before - 1000);
    release();
    await manager.waitForIdle(s.id);
    expect(manager.activity(manager.getSession(s.id))).toBeNull();
  });

  it("reports a background shell task the CLI is waiting on as running, with the reason", () => {
    // Measured: after a turn that started a Bash task in the background, the registry reads "shell"
    // until the task exits and the CLI picks up again. The official app shows this as a running task
    const { manager, home } = makeManager(okAdapter, {
      deps: { isCliLive: () => true, cliState: () => ({ pid: 4242, status: "shell", statusUpdatedAt: "2026-09-01T15:09:17.919Z", startedAt: null }) },
    });
    const { session } = liveSession(manager, home, "agent-bg-task");
    expect(manager.activity(manager.getSession(session.id))).toEqual({
      since: "2026-09-01T15:09:17.919Z", outputTokens: null, reason: "background",
    });
  });

  it("reports a turn typed into the CLI from the registry, and its tokens once the transcript is synced", () => {
    const { manager, home } = makeManager(okAdapter, {
      deps: { isCliLive: () => true, cliState: () => ({ pid: 4242, status: "busy", statusUpdatedAt: "2026-08-31T12:06:55.000Z", startedAt: null }) },
    });
    const { session, file } = liveSession(manager, home, "agent-cli-turn");
    // Nothing synced yet: the registry alone says when it started, and nothing says how far it is
    expect(manager.activity(manager.getSession(session.id))).toEqual({ since: "2026-08-31T12:06:55.000Z", outputTokens: null });
    fs.writeFileSync(file, jsonl([
      { type: "user", uuid: "h1", timestamp: "2026-08-31T12:06:56.000Z", message: { role: "user", content: "typed in the terminal" } },
      usageRecord("a1", "msg_1", 363),
      usageRecord("a2", "msg_1", 363),
      usageRecord("a3", "msg_2", 234),
    ]));
    manager.syncTranscript(session.id);
    expect(manager.activity(manager.getSession(session.id))).toEqual({ since: "2026-08-31T12:06:56.000Z", outputTokens: 597 });
  });

  it("never shows a previous turn's tokens against a turn the transcript has not been read for", () => {
    let statusUpdatedAt = "2026-08-31T12:06:55.000Z";
    const { manager, home } = makeManager(okAdapter, {
      deps: { isCliLive: () => true, cliState: () => ({ pid: 4242, status: "busy", statusUpdatedAt, startedAt: null }) },
    });
    const { session, file } = liveSession(manager, home, "agent-cli-stale");
    fs.writeFileSync(file, jsonl([
      { type: "user", uuid: "h1", timestamp: "2026-08-31T12:06:56.000Z", message: { role: "user", content: "first" } },
      usageRecord("a1", "msg_1", 999),
    ]));
    manager.syncTranscript(session.id);
    // A new turn began after that sync (the phone sat on the list, nobody synced): the old count must not show
    statusUpdatedAt = new Date(Date.now() + 60_000).toISOString();
    expect(manager.activity(manager.getSession(session.id))).toEqual({ since: statusUpdatedAt, outputTokens: null });
  });

  it("counts a permission prompt as still running, and an idle or unknown CLI as nothing", () => {
    let status: "busy" | "idle" | "waiting" | "shell" | "unknown" = "idle";
    const { manager, home } = makeManager(okAdapter, {
      deps: { isCliLive: () => true, cliState: () => ({ pid: 4242, status, statusUpdatedAt: null, startedAt: null }) },
    });
    const { session } = liveSession(manager, home, "agent-cli-states");
    const s = manager.getSession(session.id);
    expect(manager.activity(s)).toBeNull();
    status = "unknown";
    expect(manager.activity(s)).toBeNull();
    status = "shell"; // a background task the CLI waits on is work in progress (see the test below)
    expect(manager.activity(s)).toEqual({ since: null, outputTokens: null, reason: "background" });
    status = "waiting";
    expect(manager.activity(s)).toEqual({ since: null, outputTokens: null });
  });

  it("takes a live turn's tokens from the transcript the CLI writes", async () => {
    const { peer, sent, setStatus } = fakePeer();
    const { manager, home } = makeManager(okAdapter, { deps: { isCliLive: () => true, peer, liveTiming: FAST_LIVE } });
    const { session, file } = liveSession(manager, home, "agent-live-tokens");
    manager.startTurn(session.id, "hello");
    await until(() => sent.length === 1);
    setStatus({ status: "busy", waitingFor: null });
    fs.writeFileSync(file, jsonl([peerRecord(sent[0]!.msgId), usageRecord("a1", "msg_1", 120)]));
    await until(() => manager.activity(manager.getSession(session.id))?.outputTokens === 120);
    setStatus({ status: "idle", waitingFor: null });
    await manager.waitForIdle(session.id);
    expect(manager.activity(manager.getSession(session.id))).toBeNull();
  });
});

describe("SessionManager Stop on a turn the CLI started", () => {
  it("sends the CLI the same stop message a live turn gets, at 'now' priority", async () => {
    const { peer, sent } = fakePeer();
    const { manager, home } = makeManager(okAdapter, {
      deps: { isCliLive: () => true, peer, cliState: () => ({ pid: 4242, status: "busy", statusUpdatedAt: null, startedAt: null }) },
    });
    const { session } = liveSession(manager, home, "agent-cli-stop");
    await manager.interrupt(session.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.priority).toBe("now");
    expect(sent[0]!.agentSessionId).toBe("agent-cli-stop");
    expect(sent[0]!.content).toContain(PEER_STOP);
  });

  it("sends nothing when the CLI is idle", async () => {
    const { peer, sent } = fakePeer();
    const { manager, home } = makeManager(okAdapter, {
      deps: { isCliLive: () => true, peer, cliState: () => ({ pid: 4242, status: "idle", statusUpdatedAt: null, startedAt: null }) },
    });
    const { session } = liveSession(manager, home, "agent-cli-idle");
    await manager.interrupt(session.id);
    expect(sent).toHaveLength(0);
  });

  it("fails visibly when the CLI is busy but cannot be reached", async () => {
    const { peer } = fakePeer({ resolve: () => null });
    const { manager, home } = makeManager(okAdapter, {
      deps: { isCliLive: () => true, peer, cliState: () => ({ pid: 4242, status: "busy", statusUpdatedAt: null, startedAt: null }) },
    });
    const { session } = liveSession(manager, home, "agent-cli-unreachable");
    await expect(manager.interrupt(session.id)).rejects.toThrow(ConflictError);
  });

  it("surfaces a socket failure instead of swallowing it", async () => {
    const { peer } = fakePeer({ send: async () => { throw new Error("connect ENOENT /srv/cc-socks/4242.sock"); } });
    const { manager, home } = makeManager(okAdapter, {
      deps: { isCliLive: () => true, peer, cliState: () => ({ pid: 4242, status: "busy", statusUpdatedAt: null, startedAt: null }) },
    });
    const { session } = liveSession(manager, home, "agent-cli-socket");
    await expect(manager.interrupt(session.id)).rejects.toThrow(/ENOENT/);
  });
});

/** Rollout fixture in the measured codex 0.149.1 shapes, under today's date dir */
function writeCodexRollout(profilesDir: string, threadId: string, records: Array<Record<string, unknown>>): string {
  const now = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  const dir = path.join(profilesDir, "cx", "sessions", String(now.getFullYear()), p2(now.getMonth() + 1), p2(now.getDate()));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-x-${threadId}.jsonl`);
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

const cxMeta = (cwd: string) => ({ type: "session_meta", payload: { id: "x", cwd, timestamp: "2026-09-01T00:00:00.000Z" } });
const cxTaskStart = { type: "event_msg", payload: { type: "task_started", turn_id: "t1", started_at: 1788000000 } };
const cxUser = (text: string) => ({ type: "event_msg", payload: { type: "user_message", message: text } });
const cxTokens = (out: number) => ({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { output_tokens: out } } } });
const cxAnswer = { type: "event_msg", payload: { type: "agent_message", message: "done", phase: "final_answer" } };
const cxTaskEnd = { type: "event_msg", payload: { type: "task_complete", turn_id: "t1", completed_at: 1788000010 } };

describe("SessionManager external sessions (Step 3 Wave 1)", () => {
  const TID = "01a04e08-f742-7aa2-b039-b3a952f6ef99";

  it("adopts a codex CLI session from its storage, imports it, and shows the open turn as activity", async () => {
    const { manager, stores, home } = makeManager(okAdapter, { deps: { liveScanEnabled: () => true } });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cwd-"));
    const profilesDir = path.join(home, "profiles");
    const seen: EventRecord[] = [];
    manager.on("event", (e) => seen.push(e));
    writeCodexRollout(profilesDir, TID, [cxMeta(cwd), cxTaskStart, cxUser("fix the failing test"), cxTokens(81)]);

    expect(manager.scanExternalSessions()).toBe(1);
    expect(manager.scanExternalSessions()).toBe(0); // idempotent
    const s = manager.listSessions().find((x) => x.agentSessionId === TID)!;
    expect(s.agent).toBe("codex");
    expect(s.cwd).toBe(cwd);
    expect(s.title).toBe("fix the failing test");
    expect(seen.map((e) => e.type)).toEqual(["user_message"]);

    // The open turn shows as running, and a send is refused (no live join for codex yet)
    expect(manager.activity(manager.getSession(s.id))).toEqual({ since: "2026-08-29T10:40:00.000Z", outputTokens: 81 });
    expect(() => manager.startTurn(s.id, "hi")).toThrow(ConflictError);

    // Process-level evidence saying "nobody is there" clears it
    const { manager: m2, home: h2 } = makeManager(okAdapter, { deps: { liveScanEnabled: () => true, externalBusy: () => false } });
    writeCodexRollout(path.join(h2, "profiles"), TID, [cxMeta(cwd), cxTaskStart, cxUser("x"), cxTokens(1)]);
    m2.scanExternalSessions();
    const s2 = m2.listSessions()[0]!;
    expect(m2.activity(m2.getSession(s2.id))).toBeNull();
  });

  it("a finished codex turn closes the activity and lets tiny run its own turn without replaying it", async () => {
    let launched = 0;
    let rollout = "";
    // The real app-server appends tiny's own turn to the SAME rollout while it runs
    const echoId: AgentAdapter = {
      async runTurn(p: RunTurnParams) {
        launched++;
        p.emit({ type: "turn_started", payload: { agentSessionId: p.agentSessionId } });
        fs.appendFileSync(rollout, [cxTaskStart, cxUser(p.prompt), cxAnswer, cxTaskEnd].map((r) => JSON.stringify(r)).join("\n") + "\n");
        p.emit({ type: "turn_completed", payload: {} });
        return { agentSessionId: p.agentSessionId!, costUsd: null, resultText: "ok" };
      },
    };
    const { manager, stores, home } = makeManager(echoId, { deps: { liveScanEnabled: () => true } });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cwd-"));
    const profilesDir = path.join(home, "profiles");
    rollout = writeCodexRollout(profilesDir, TID, [cxMeta(cwd), cxTaskStart, cxUser("do it"), cxTokens(5), cxAnswer, cxTaskEnd]);
    manager.scanExternalSessions();
    const s = manager.listSessions()[0]!;
    expect(manager.activity(manager.getSession(s.id))).toBeNull();
    const before = stores.events.listSince(s.id, 0).length;

    manager.startTurn(s.id, "from the phone");
    await manager.waitForIdle(s.id);
    expect(launched).toBe(1);
    // What tiny's own turn appended to the rollout must not come back as an import…
    manager.syncTranscript(s.id);
    const after = stores.events.listSince(s.id, 0).map((e) => e.type);
    expect(after.filter((t) => t === "user_message").length).toBe(2);
    expect(after.length).toBe(before + 3); // user_message + turn_started + turn_completed, nothing replayed
    // …while a turn the person then types into the CLI still comes in
    fs.appendFileSync(rollout, [cxTaskStart, cxUser("typed in the terminal"), cxAnswer, cxTaskEnd].map((r) => JSON.stringify(r)).join("\n") + "\n");
    manager.syncTranscript(s.id);
    const types = stores.events.listSince(s.id, 0).map((e) => e.type);
    expect(types.filter((t) => t === "user_message").length).toBe(3);
    expect(types.at(-1)).toBe("assistant_text");
  });

  it("adopts an opencode CLI session and follows its storage, holding at an unfinished reply", () => {
    const { manager, home } = makeManager(okAdapter, { deps: { liveScanEnabled: () => true } });
    const profilesDir = path.join(home, "profiles");
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cwd-"));
    const dataDir = path.join(profilesDir, "oc", "xdg", "data", "opencode");
    fs.mkdirSync(dataDir, { recursive: true });
    const db = new (require("better-sqlite3"))(path.join(dataDir, "opencode.db"));
    db.exec(`CREATE TABLE session (id text PRIMARY KEY, directory text NOT NULL, title text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, time_archived integer);
             CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
             CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);`);
    db.prepare("INSERT INTO session VALUES ('ses_1', ?, 'lint the repo', 1000, 2000, NULL)").run(cwd);
    db.prepare("INSERT INTO message VALUES ('m_u1','ses_1',1000,1000,?)").run(JSON.stringify({ role: "user", time: { created: 1000 } }));
    db.prepare("INSERT INTO part VALUES ('p1','m_u1','ses_1',1000,1000,?)").run(JSON.stringify({ type: "text", text: "lint please" }));
    db.prepare("INSERT INTO message VALUES ('m_a1','ses_1',1500,1500,?)").run(JSON.stringify({ role: "assistant", time: { created: 1500 } }));

    expect(manager.scanExternalSessions()).toBe(1);
    const s = manager.listSessions()[0]!;
    expect(s.agent).toBe("opencode");
    expect(s.title).toBe("lint the repo");
    expect(manager.activity(manager.getSession(s.id))).toMatchObject({ since: "1970-01-01T00:00:01.000Z" });

    db.prepare("UPDATE message SET data = ? WHERE id='m_a1'").run(
      JSON.stringify({ role: "assistant", time: { created: 1500, completed: 1900 }, tokens: { output: 7 } }),
    );
    db.prepare("INSERT INTO part VALUES ('p2','m_a1','ses_1',1500,1500,?)").run(JSON.stringify({ type: "text", text: "clean" }));
    manager.syncTranscript(s.id);
    expect(manager.activity(manager.getSession(s.id))).toBeNull();
    db.close();
  });

  it("does not adopt empty sessions or scan profiles without live on", () => {
    const { manager, home } = makeManager(okAdapter, { deps: { liveScanEnabled: (name) => name === "cx" } });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cwd-"));
    const profilesDir = path.join(home, "profiles");
    writeCodexRollout(profilesDir, "01a04e08-f742-7aa2-b039-b3a952f6ef01", [cxMeta(cwd)]); // no user message
    expect(manager.scanExternalSessions()).toBe(0);
  });
});

// A restart of tinyd loses every turn it was driving. What the phone must be told depends on who
// was actually doing the work
describe("SessionManager restart recovery", () => {
  function runningSession(manager: SessionManager, stores: ReturnType<typeof createStores>, home: string, agentSessionId: string) {
    const { session } = liveSession(manager, home, agentSessionId);
    // What the previous tinyd left behind: status running, a turn_started with nothing closing it
    stores.events.append(session.id, "user_message", { text: "hello" });
    stores.events.append(session.id, "turn_started", { agentSessionId });
    stores.sessions.patch(session.id, { status: "running" });
    return session;
  }

  it("closes a turn the CLI still holds as completed — the CLI kept working through the restart", () => {
    const { peer } = fakePeer();
    const { manager, stores, home } = makeManager(okAdapter, { deps: { isCliLive: () => true, peer } });
    const session = runningSession(manager, stores, home, "agent-live");
    const seen: EventRecord[] = [];
    manager.on("event", (e) => seen.push(e));
    expect(manager.recoverAfterRestart()).toBe(1);
    expect(seen.map((e) => e.type)).toEqual(["turn_completed"]);
    expect(seen[0]!.payload).toEqual({ costUsd: null, resultText: null });
    expect(stores.sessions.get(session.id)!.status).toBe("idle");
  });

  it("closes tiny's own turn as interrupted — its child died with the daemon", () => {
    const { manager, stores, home } = makeManager(okAdapter, { deps: { isCliLive: () => false } });
    const session = runningSession(manager, stores, home, "agent-own");
    const seen: EventRecord[] = [];
    manager.on("event", (e) => seen.push(e));
    expect(manager.recoverAfterRestart()).toBe(1);
    expect(seen.map((e) => e.type)).toEqual(["turn_failed"]);
    expect(seen[0]!.payload).toEqual({ error: "interrupted" });
    expect(stores.sessions.get(session.id)!.status).toBe("idle");
  });

  it("repairs a session an older tinyd left as interrupted with its turn still open", () => {
    const { peer } = fakePeer();
    const { manager, stores, home } = makeManager(okAdapter, { deps: { isCliLive: () => true, peer } });
    const session = runningSession(manager, stores, home, "agent-old");
    stores.sessions.patch(session.id, { status: "interrupted" });
    const seen: EventRecord[] = [];
    manager.on("event", (e) => seen.push(e));
    expect(manager.recoverAfterRestart()).toBe(1);
    expect(seen.map((e) => e.type)).toEqual(["turn_completed"]);
    expect(stores.sessions.get(session.id)!.status).toBe("idle");
  });

  it("only sets the status right when the turn was already closed in the log", () => {
    const { manager, stores, home } = makeManager(okAdapter, { deps: { isCliLive: () => false } });
    const session = runningSession(manager, stores, home, "agent-closed");
    stores.events.append(session.id, "turn_completed", { costUsd: null, resultText: "done" });
    const seen: EventRecord[] = [];
    manager.on("event", (e) => seen.push(e));
    expect(manager.recoverAfterRestart()).toBe(1);
    expect(seen).toEqual([]);
    expect(stores.sessions.get(session.id)!.status).toBe("idle");
  });

  it("leaves idle sessions alone", () => {
    const { manager, home } = makeManager(okAdapter, { deps: { isCliLive: () => true, peer: fakePeer().peer } });
    liveSession(manager, home, "agent-idle");
    const seen: EventRecord[] = [];
    manager.on("event", (e) => seen.push(e));
    expect(manager.recoverAfterRestart()).toBe(0);
    expect(seen).toEqual([]);
  });
});
