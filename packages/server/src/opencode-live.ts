import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { opencodeXdg } from "./agents/opencode.js";
import type { ExternalRead, ExternalSession, ExternalTurn } from "./agent-storage.js";
import type { TranscriptEvent } from "./claude-transcript.js";
import { oneLine } from "./tool-kinds.js";

/**
 * Read-only readers for OpenCode's own storage (UNDOCUMENTED interfaces, measured 2026-09-01 on
 * opencode 1.18.18 — see HANDOFF "Step 3"):
 *   $XDG_DATA_HOME/opencode/opencode.db          session / message / part tables (WAL)
 *   $XDG_STATE_HOME/opencode/locks/<sha1>.lock/  meta.json { pid, ... } per STORAGE (not per cwd
 *                                                — measured: two instances share one lock), stale
 *                                                after a kill, so only a live pid counts
 * The db is opened read-only per call and every reader degrades to null / empty.
 */

function dbPath(profileDir: string): string {
  return path.join(opencodeXdg(profileDir).data, "opencode", "opencode.db");
}

function withDb<T>(profileDir: string, fn: (db: Database.Database) => T): T | null {
  let db: Database.Database;
  try {
    db = new Database(dbPath(profileDir), { readonly: true, fileMustExist: true });
  } catch {
    return null; // no storage yet
  }
  try {
    db.pragma("busy_timeout = 200");
    return fn(db);
  } catch {
    return null;
  } finally {
    db.close();
  }
}

interface MessageRow {
  id: string;
  time_created: number;
  data: string;
}

interface MessageData {
  role?: string;
  time?: { created?: number; completed?: number };
  tokens?: { output?: number };
}

function parseData(row: { data: string }): MessageData | null {
  try {
    return JSON.parse(row.data) as MessageData;
  } catch {
    return null;
  }
}

/** Sessions that carry at least one user message (empty ones include tiny's own choice-fetch probes) */
export function listOpencodeSessions(profileDir: string): ExternalSession[] {
  return (
    withDb(profileDir, (db) => {
      const rows = db
        .prepare(
          `SELECT s.id, s.directory, s.title, s.time_created FROM session s
           WHERE s.time_archived IS NULL
             AND EXISTS (SELECT 1 FROM message m WHERE m.session_id = s.id AND m.data LIKE '%"role":"user"%')
           ORDER BY s.time_updated DESC LIMIT 100`,
        )
        .all() as Array<{ id: string; directory: string; title: string; time_created: number }>;
      return rows.map((r) => ({
        agentSessionId: r.id,
        cwd: r.directory,
        startedAt: Number.isFinite(r.time_created) ? new Date(r.time_created).toISOString() : null,
        title: r.title !== "" ? r.title : null,
      }));
    }) ?? []
  );
}

/**
 * Import messages committed since the cursor. An assistant message still missing time.completed is
 * mid-turn: nothing at or after it is imported (its parts are still growing), and it becomes the
 * open turn instead. Cursor = time_created:id of the last imported message.
 */
export function readOpencodeSession(profileDir: string, agentSessionId: string, sinceCursor: string | null): ExternalRead | null {
  return withDb(profileDir, (db) => {
    const m = sinceCursor?.match(/^t:(\d+):(.+)$/);
    const sinceTime = m ? Number(m[1]) : -1;
    const sinceId = m ? m[2]! : "";
    const rows = db
      .prepare(
        `SELECT id, time_created, data FROM message
         WHERE session_id = ? AND (time_created > ? OR (time_created = ? AND id > ?))
         ORDER BY time_created, id`,
      )
      .all(agentSessionId, sinceTime, sinceTime, sinceId) as MessageRow[];
    const partsFor = db.prepare(`SELECT data FROM part WHERE message_id = ? ORDER BY id`);
    const titleRow = db.prepare(`SELECT title FROM session WHERE id = ?`).get(agentSessionId) as { title?: string } | undefined;

    const events: TranscriptEvent[] = [];
    let cursor = sinceCursor ?? "";
    let turn: ExternalTurn | null = null;
    let turnTokens = 0;
    for (const row of rows) {
      const data = parseData(row);
      if (!data) {
        cursor = `t:${row.time_created}:${row.id}`;
        continue;
      }
      if (data.role === "user") {
        const texts: string[] = [];
        for (const p of partsFor.all(row.id) as Array<{ data: string }>) {
          const part = parseData(p) as { type?: string; text?: string } | null;
          if (part?.type === "text" && typeof part.text === "string" && part.text !== "") texts.push(part.text);
        }
        if (texts.length > 0) events.push({ type: "user_message", payload: { text: texts.join("\n") } });
        cursor = `t:${row.time_created}:${row.id}`;
        // A user message with no reply yet is a turn that just started
        turn = { startedAt: new Date(row.time_created).toISOString(), outputTokens: null, open: true };
        turnTokens = 0;
        continue;
      }
      if (data.role !== "assistant") {
        cursor = `t:${row.time_created}:${row.id}`;
        continue;
      }
      if (typeof data.time?.completed !== "number") {
        // Mid-turn: stop here so the still-growing parts are imported next time, whole
        turn = {
          startedAt: turn?.startedAt ?? (typeof data.time?.created === "number" ? new Date(data.time.created).toISOString() : null),
          outputTokens: turnTokens > 0 ? turnTokens : null,
          open: true,
        };
        break;
      }
      for (const p of partsFor.all(row.id) as Array<{ data: string }>) {
        const part = parseData(p) as Record<string, any> | null;
        if (!part) continue;
        if (part.type === "reasoning" && typeof part.text === "string" && part.text.trim() !== "") {
          events.push({ type: "assistant_thinking", payload: { text: part.text } });
        } else if (part.type === "text" && typeof part.text === "string" && part.text !== "") {
          events.push({ type: "assistant_text", payload: { text: part.text } });
        } else if (part.type === "tool" && typeof part.callID === "string") {
          const input = part.state?.input && typeof part.state.input === "object" ? part.state.input : {};
          events.push({
            type: "tool_started",
            payload: {
              toolName: typeof part.tool === "string" ? part.tool : "tool",
              toolUseId: part.callID,
              input,
              kind: "execute",
              summary: oneLine(String(part.state?.title ?? part.tool ?? "tool")),
            },
          });
          events.push({ type: "tool_finished", payload: { toolUseId: part.callID, isError: part.state?.status === "error" } });
        }
        // patch / file / step-start / step-finish are bookkeeping
      }
      if (typeof data.tokens?.output === "number") turnTokens += data.tokens.output;
      // Completing a reply closes the turn — also when its user message went out with a previous
      // read and this read never saw a turn open (startedAt null = "keep what you had")
      turn = {
        startedAt: turn?.startedAt ?? null,
        outputTokens: turnTokens > 0 ? turnTokens : turn?.outputTokens ?? null,
        open: false,
      };
      cursor = `t:${row.time_created}:${row.id}`;
    }
    return { events, cursor, turn, title: titleRow?.title ? titleRow.title : null };
  });
}

/** The tail cursor (newest committed message), for seeding without importing */
export function opencodeSessionCursor(profileDir: string, agentSessionId: string): string | null {
  return withDb(profileDir, (db) => {
    const row = db
      .prepare(`SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT 1`)
      .get(agentSessionId) as MessageRow | undefined;
    if (!row) return "";
    const data = parseData(row);
    // Never seed past an unfinished assistant message — its parts must still be imported
    if (data?.role === "assistant" && typeof data.time?.completed !== "number") return null;
    return `t:${row.time_created}:${row.id}`;
  });
}

/** mtime/size fingerprint of the storage (db + WAL), for the "nothing changed" fast path */
export function opencodeDbStat(profileDir: string): { size: number; mtimeMs: number } | null {
  const base = dbPath(profileDir);
  let size = 0;
  let mtimeMs = 0;
  let seen = false;
  for (const f of [base, `${base}-wal`]) {
    try {
      const st = fs.statSync(f);
      size += st.size;
      mtimeMs = Math.max(mtimeMs, st.mtimeMs);
      seen = true;
    } catch {
      // the WAL may not exist; the db itself may not either
    }
  }
  return seen ? { size, mtimeMs } : null;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pids of live OpenCode instances on this profile's storage. The lock directory outlives a killed
 * instance (measured), so a dead pid counts for nothing.
 */
export function opencodeInstancePids(profileDir: string, alive: (pid: number) => boolean = processAlive): number[] {
  const locks = path.join(opencodeXdg(profileDir).state, "opencode", "locks");
  let names: string[];
  try {
    names = fs.readdirSync(locks);
  } catch {
    return [];
  }
  const pids: number[] = [];
  for (const name of names) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(locks, name, "meta.json"), "utf8")) as { pid?: unknown };
      if (typeof meta.pid === "number" && alive(meta.pid)) pids.push(meta.pid);
    } catch {
      // a half-written or foreign entry
    }
  }
  return pids;
}
