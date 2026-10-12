import fs from "node:fs";
import { toolOutputPayload } from "./tool-output.js";
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
 * The db is opened read-only per call and every reader degrades to null / empty.
 *
 * Which opencode processes are alive and what they are doing is NOT in the storage: the
 * $XDG_STATE_HOME/opencode/locks entries this module once read are short-lived cache locks
 * (models.dev, npm installs — opencode 1.18.35 core/util/flock.ts), not one per running instance.
 * That lives in opencode-peer.ts
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
  /** Set on a reply that failed (measured 1.18.35: { name: "APIError", data: { message } }) */
  error?: { name?: unknown; data?: { message?: unknown } };
}

/** What went wrong with a reply, in opencode's own words. null = nothing */
function replyError(data: MessageData): string | null {
  const e = data.error;
  if (!e || typeof e !== "object") return null;
  const message = typeof e.data?.message === "string" && e.data.message !== "" ? e.data.message : null;
  const name = typeof e.name === "string" ? e.name : "error";
  return message ?? name;
}

function parseData(row: { data: string }): MessageData | null {
  try {
    return JSON.parse(row.data) as MessageData;
  } catch {
    return null;
  }
}

/**
 * opencode's title before its small model names the session (measured 1.18.35: "New session - <ISO>",
 * "Child session - <ISO>" for subagents). It stays forever when that model cannot answer — e.g. a
 * local LM Studio model that is not running
 */
const PLACEHOLDER_TITLE = /^(New|Child) session - \d{4}-\d{2}-\d{2}T/;

/** The session's title, or the first thing the person said while it still has the placeholder */
function sessionTitle(db: Database.Database, sessionId: string, title: string | undefined): string | null {
  if (title && !PLACEHOLDER_TITLE.test(title)) return title;
  const parts = db
    .prepare(
      `SELECT p.data FROM message m JOIN part p ON p.message_id = m.id
       WHERE m.session_id = ? AND m.data LIKE '%"role":"user"%'
       ORDER BY m.time_created, m.id, p.id`,
    )
    .all(sessionId) as Array<{ data: string }>;
  for (const p of parts) {
    const part = parseData(p) as { type?: string; text?: string; synthetic?: boolean } | null;
    if (part?.type !== "text" || typeof part.text !== "string" || part.synthetic === true) continue;
    const text = oneLine(part.text);
    if (text !== "") return text;
  }
  return null;
}

/**
 * Sessions that carry at least one user message (empty ones include tiny's own choice-fetch probes).
 * Subagent sessions (parent_id set) are part of their parent's turn, not something to open on the phone
 */
export function listOpencodeSessions(profileDir: string): ExternalSession[] {
  return (
    withDb(profileDir, (db) => {
      const rows = db
        .prepare(
          `SELECT s.id, s.directory, s.title, s.time_created, s.time_updated FROM session s
           WHERE s.time_archived IS NULL AND s.parent_id IS NULL
             AND EXISTS (SELECT 1 FROM message m WHERE m.session_id = s.id AND m.data LIKE '%"role":"user"%')
           ORDER BY s.time_updated DESC LIMIT 100`,
        )
        .all() as Array<{ id: string; directory: string; title: string; time_created: number; time_updated: number }>;
      return rows.map((r) => ({
        agentSessionId: r.id,
        cwd: r.directory,
        startedAt: Number.isFinite(r.time_created) ? new Date(r.time_created).toISOString() : null,
        lastActiveAt: Number.isFinite(r.time_updated) ? new Date(r.time_updated).toISOString() : null,
        title: sessionTitle(db, r.id, r.title),
      }));
    }) ?? []
  );
}

/**
 * Import messages committed since the cursor. An assistant message still missing time.completed is
 * mid-turn: nothing at or after it is imported (its parts are still growing), and it becomes the
 * open turn instead — unless a NEWER assistant message exists. A session runs one reply at a time,
 * so a reply something else has already followed was abandoned by its process (killed, or hung on a
 * prompt nobody could answer) and will never complete: it is imported as it stands and the read goes
 * on. A newer USER message proves nothing — typing during a turn stores it at once.
 * Cursor = time_created:id of the last imported message.
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

    const datas = rows.map(parseData);
    // Index of the newest assistant message in this read: anything unfinished before it was abandoned
    let lastAssistant = -1;
    datas.forEach((d, i) => {
      if (d?.role === "assistant") lastAssistant = i;
    });

    const events: TranscriptEvent[] = [];
    let cursor = sinceCursor ?? "";
    let turn: ExternalTurn | null = null;
    let turnTokens = 0;
    let error: string | null | undefined;
    for (const [i, row] of rows.entries()) {
      const data = datas[i];
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
      const abandoned = typeof data.time?.completed !== "number" && i < lastAssistant;
      if (typeof data.time?.completed !== "number" && !abandoned) {
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
          // A tool its process never finished did not succeed
          const isError = abandoned ? part.state?.status !== "completed" : part.state?.status === "error";
          events.push({
            type: "tool_finished",
            payload: { toolUseId: part.callID, isError, ...toolOutputPayload(part.state?.output) },
          });
        }
        // patch / file / step-start / step-finish are bookkeeping
      }
      if (typeof data.tokens?.output === "number") turnTokens += data.tokens.output;
      error = replyError(data);
      // Completing a reply closes the turn — also when its user message went out with a previous
      // read and this read never saw a turn open (startedAt null = "keep what you had")
      turn = {
        startedAt: turn?.startedAt ?? null,
        outputTokens: turnTokens > 0 ? turnTokens : turn?.outputTokens ?? null,
        open: false,
      };
      cursor = `t:${row.time_created}:${row.id}`;
    }
    return {
      events, cursor, turn, title: sessionTitle(db, agentSessionId, titleRow?.title),
      ...(error !== undefined ? { replyError: error } : {}),
    };
  });
}

/**
 * The tail cursor (newest committed message), for seeding without importing. `includeUnfinished`
 * is for a caller that knows the process writing the tail is gone (tiny's own turn just ended):
 * that reply stays unfinished forever and must not be imported on top of the events tiny emitted
 */
export function opencodeSessionCursor(profileDir: string, agentSessionId: string, opts: { includeUnfinished?: boolean } = {}): string | null {
  return withDb(profileDir, (db) => {
    const row = db
      .prepare(`SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT 1`)
      .get(agentSessionId) as MessageRow | undefined;
    if (!row) return "";
    const data = parseData(row);
    // Never seed past an unfinished assistant message — its parts must still be imported
    if (!opts.includeUnfinished && data?.role === "assistant" && typeof data.time?.completed !== "number") return null;
    return `t:${row.time_created}:${row.id}`;
  });
}

export interface OpencodeChoice {
  /** The agent (build / plan / ...) the newest user message went to. null = none recorded */
  agent: string | null;
  /** The model it ran on, as opencode records it on the user message. null = none recorded */
  model: { providerID: string; modelID: string; variant?: string } | null;
}

/**
 * What the session last ran with: the newest user message's agent and model (measured 1.18.35:
 * `{"role":"user","agent":"build","model":{"providerID","modelID","variant"}}`). A message handed to
 * the person's terminal continues on these unless the phone picked something else
 */
export function opencodeLastChoice(profileDir: string, agentSessionId: string): OpencodeChoice {
  return (
    withDb(profileDir, (db) => {
      const row = db
        .prepare(
          `SELECT data FROM message WHERE session_id = ? AND data LIKE '%"role":"user"%'
           ORDER BY time_created DESC, id DESC LIMIT 1`,
        )
        .get(agentSessionId) as { data: string } | undefined;
      const data = row ? (parseData(row) as { agent?: unknown; model?: Record<string, unknown> } | null) : null;
      const m = data?.model;
      const model =
        m && typeof m.providerID === "string" && typeof m.modelID === "string"
          ? { providerID: m.providerID, modelID: m.modelID, ...(typeof m.variant === "string" ? { variant: m.variant } : {}) }
          : null;
      return { agent: typeof data?.agent === "string" ? data.agent : null, model };
    }) ?? { agent: null, model: null }
  );
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
