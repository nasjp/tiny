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
import type { PeerFrame, PeerStatus } from "../src/claude-peer.js";
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

  it("discardIfEmpty imports the transcript before judging the session empty", () => {
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

    // SessionEnd must not throw away a session that held a real exchange
    expect(manager.discardIfEmpty("agent-late")).toBe(false);
    expect(stores.sessions.get(session.id)).not.toBeNull();
    expect(stores.events.listSince(session.id, 0).map((e) => e.type))
      .toEqual(["user_message", "assistant_text"]);
    // the title fallback rides along with the import
    expect(manager.getSession(session.id).title).toBe("what does this repo do");
  });

  it("discardIfEmpty keeps a session whose import was skipped because it is running", () => {
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
    expect(manager.discardIfEmpty("agent-busy")).toBe(false);
    expect(stores.sessions.get(session.id)).not.toBeNull();
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

  describe("SessionManager live turns (CLI holds the session)", () => {
    it("sends the turn to the CLI instead of 409, then completes from what the CLI writes", async () => {
      const { peer, sent, setStatus } = fakePeer();
      const { manager, stores, home } = makeManager(okAdapter, { deps: { isCliLive: () => true, peer, liveTiming: FAST_LIVE } });
      const { session, file } = liveSession(manager, home, "agent-live");
      const seen: EventRecord[] = [];
      manager.on("event", (e) => seen.push(e));

      manager.startTurn(session.id, "hello from the phone");
      expect(stores.sessions.get(session.id)!.status).toBe("running");
      await until(() => sent.length === 1);
      expect(sent[0]!.agentSessionId).toBe("agent-live");
      expect(sent[0]!.content).toMatch(/^<cross-session-message from-name="tiny" from-mode="prompting">\nhello from the phone\n/);

      // the CLI runs it: registry goes busy, the transcript gets our record and the reply, then idle
      setStatus({ status: "busy", waitingFor: null });
      fs.writeFileSync(file, jsonl([peerRecord(sent[0]!.msgId), assistantRecord("hi phone")]));
      setStatus({ status: "idle", waitingFor: null });
      await manager.waitForIdle(session.id);

      expect(seen.map((e) => e.type)).toEqual(["user_message", "turn_started", "assistant_text", "turn_completed"]);
      expect(seen[0]!.payload.text).toBe("hello from the phone");
      expect(stores.sessions.get(session.id)!.status).toBe("idle");
      // the CLI's own record of our message must not come back as a second user bubble
      expect(seen.filter((e) => e.type === "user_message")).toHaveLength(1);
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
      fs.writeFileSync(file, jsonl([peerRecord(sent[0]!.msgId), assistantRecord("late reply")]));
      setStatus({ status: "idle", waitingFor: null });
      await manager.waitForIdle(session.id);
      expect(seen.at(-1)!.type).toBe("turn_completed");
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
});

/** Watcher timings short enough for tests: poll 10ms, give up on delivery after 200ms idle, 2s max */
const FAST_LIVE = { pollMs: 10, deliveryTimeoutMs: 200, maxTurnMs: 2000 };

function fakePeer(over: Partial<PeerBridge> = {}) {
  const sent: PeerFrame[] = [];
  let status: PeerStatus | null = { status: "idle", waitingFor: null };
  const peer: PeerBridge = {
    resolve: () => ({ pid: 4242, sockPath: "/srv/cc-socks/4242.sock" }),
    status: () => status,
    mode: () => "prompting",
    send: async (_s, _t, frame) => {
      sent.push(frame);
    },
    ...over,
  };
  return { peer, sent, setStatus: (st: PeerStatus | null) => { status = st; } };
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

const jsonl = (records: Array<Record<string, unknown>>) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";
