import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { opencodeXdg } from "../src/agents/opencode.js";
import {
  listOpencodeSessions, opencodeDbStat, opencodeInstancePids, opencodeSessionCursor, readOpencodeSession,
} from "../src/opencode-live.js";

const SID = "ses_fixture1";

/** The measured 1.18.18 schema, columns tiny reads only */
function makeStorage(): { profileDir: string; db: Database.Database } {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-oc-"));
  const dataDir = path.join(opencodeXdg(profileDir).data, "opencode");
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, "opencode.db"));
  db.exec(`
    CREATE TABLE session (id text PRIMARY KEY, directory text NOT NULL, title text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL, time_archived integer);
    CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
  `);
  db.prepare("INSERT INTO session VALUES (?,?,?,?,?,NULL)").run(SID, "/Users/x/repo", "fix the tests", 1788192888365, 1788192890990);
  return { profileDir, db };
}

let n = 0;
function addMessage(db: Database.Database, id: string, at: number, data: Record<string, unknown>, parts: Array<Record<string, unknown>> = []): void {
  db.prepare("INSERT INTO message VALUES (?,?,?,?,?)").run(id, SID, at, at, JSON.stringify(data));
  for (const p of parts) db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)").run(`prt_${++n}`, id, SID, at, at, JSON.stringify(p));
}

describe("opencode-live", () => {
  it("lists sessions that carry a user message, with directory and title", () => {
    const { profileDir, db } = makeStorage();
    expect(listOpencodeSessions(profileDir)).toEqual([]); // no user message yet (choice-probe debris)
    addMessage(db, "msg_u1", 1000, { role: "user", time: { created: 1000 } }, [{ type: "text", text: "hello" }]);
    expect(listOpencodeSessions(profileDir)).toEqual([
      { agentSessionId: SID, cwd: "/Users/x/repo", startedAt: "2026-08-31T16:14:48.365Z", title: "fix the tests" },
    ]);
    db.prepare("UPDATE session SET time_archived = 1 WHERE id = ?").run(SID);
    expect(listOpencodeSessions(profileDir)).toEqual([]);
  });

  it("imports committed messages, holds at an unfinished assistant, and reports the turn", () => {
    const { profileDir, db } = makeStorage();
    addMessage(db, "msg_u1", 1000, { role: "user", time: { created: 1000 } }, [{ type: "text", text: "run the tests" }]);
    addMessage(db, "msg_a1", 1500, {
      role: "assistant", time: { created: 1500, completed: 2400 }, tokens: { output: 47 },
    }, [
      { type: "step-start" },
      { type: "reasoning", text: "Simple request.", time: { start: 1, end: 2 } },
      { type: "tool", tool: "bash", callID: "call_1", state: { status: "completed", input: { command: "pnpm test" }, title: "pnpm test", output: "42 passed" } },
      { type: "text", text: "All green." },
      { type: "step-finish", tokens: { output: 47 } },
    ]);
    const r1 = readOpencodeSession(profileDir, SID, null)!;
    expect(r1.events.map((e) => e.type)).toEqual([
      "user_message", "assistant_thinking", "tool_started", "tool_finished", "assistant_text",
    ]);
    expect(r1.events[2]!.payload).toMatchObject({ toolName: "bash", toolUseId: "call_1", summary: "pnpm test" });
    expect(r1.events[3]!.payload).toEqual({ toolUseId: "call_1", isError: false, output: "42 passed" });
    expect(r1.turn).toEqual({ startedAt: "1970-01-01T00:00:01.000Z", outputTokens: 47, open: false });
    expect(r1.title).toBe("fix the tests");

    // A new user message plus an unfinished assistant = an open turn; nothing half-grown is imported
    addMessage(db, "msg_u2", 3000, { role: "user", time: { created: 3000 } }, [{ type: "text", text: "and lint?" }]);
    addMessage(db, "msg_a2", 3200, { role: "assistant", time: { created: 3200 } }, [{ type: "text", text: "Linti" }]);
    const r2 = readOpencodeSession(profileDir, SID, r1.cursor)!;
    expect(r2.events.map((e) => e.type)).toEqual(["user_message"]);
    expect(r2.turn).toMatchObject({ open: true });
    // finishing the message lets the next read take it whole
    db.prepare("UPDATE message SET data = ? WHERE id = 'msg_a2'").run(
      JSON.stringify({ role: "assistant", time: { created: 3200, completed: 3300 }, tokens: { output: 9 } }),
    );
    db.prepare("UPDATE part SET data = ? WHERE message_id = 'msg_a2'").run(JSON.stringify({ type: "text", text: "Linting too." }));
    const r3 = readOpencodeSession(profileDir, SID, r2.cursor)!;
    expect(r3.events.map((e) => e.type)).toEqual(["assistant_text"]);
    expect(r3.events[0]!.payload).toEqual({ text: "Linting too." });
    expect(r3.turn).toMatchObject({ open: false, outputTokens: 9 });
    expect(readOpencodeSession(profileDir, SID, r3.cursor)!.events).toEqual([]);
  });

  it("cursor seeding refuses to skip an unfinished assistant message", () => {
    const { profileDir, db } = makeStorage();
    expect(opencodeSessionCursor(profileDir, SID)).toBe("");
    addMessage(db, "msg_u1", 1000, { role: "user", time: { created: 1000 } }, [{ type: "text", text: "x" }]);
    expect(opencodeSessionCursor(profileDir, SID)).toBe("t:1000:msg_u1");
    addMessage(db, "msg_a1", 1500, { role: "assistant", time: { created: 1500 } });
    expect(opencodeSessionCursor(profileDir, SID)).toBeNull();
  });

  it("db stat and instance pids degrade to nothing on a missing or stale storage", () => {
    const { profileDir } = makeStorage();
    expect(opencodeDbStat(profileDir)).not.toBeNull();
    expect(opencodeDbStat("/no/such/profile")).toBeNull();
    expect(opencodeInstancePids(profileDir)).toEqual([]);
    const locks = path.join(opencodeXdg(profileDir).state, "opencode", "locks", "abc.lock");
    fs.mkdirSync(locks, { recursive: true });
    fs.writeFileSync(path.join(locks, "meta.json"), JSON.stringify({ pid: 4242, token: "t" }));
    expect(opencodeInstancePids(profileDir, () => true)).toEqual([4242]);
    expect(opencodeInstancePids(profileDir, () => false)).toEqual([]);
  });
});
