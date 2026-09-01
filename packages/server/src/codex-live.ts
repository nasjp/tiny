import fs from "node:fs";
import { toolOutputPayload } from "./tool-output.js";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { ExternalRead, ExternalSession, ExternalTurn } from "./agent-storage.js";
import type { TranscriptEvent } from "./claude-transcript.js";
import { oneLine } from "./tool-kinds.js";

/**
 * Read-only readers for Codex's own storage (UNDOCUMENTED interfaces, measured 2026-09-01 on
 * codex-cli 0.149.1 — see HANDOFF "Step 3"):
 *   <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<ISO>-<threadId>.jsonl   append-only transcript
 *   <CODEX_HOME>/thread-writer-locks/<threadId>.lock                  held open (lsof-visible) while a writer runs
 * Everything here degrades to null / empty — a broken or missing file means "cannot tell", never a throw.
 */

/** ~/.codex/sessions can hold 13GB+; only date directories this recent are ever scanned */
const SCAN_DAYS = 2;
/** A first import of a huge rollout starts this far from the end instead of at byte 0 */
const MAX_BACKFILL_BYTES = 512 * 1024;

const FILE_RE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

function dateDir(sessionsDir: string, d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return path.join(sessionsDir, String(d.getFullYear()), p(d.getMonth() + 1), p(d.getDate()));
}

interface RolloutRecord {
  timestamp?: string;
  type?: string;
  payload?: Record<string, any>;
}

function parseLines(raw: string): { records: RolloutRecord[]; consumed: number } {
  const records: RolloutRecord[] = [];
  let consumed = 0;
  let at = 0;
  for (;;) {
    const nl = raw.indexOf("\n", at);
    if (nl < 0) break; // a partially written last line is normal while the CLI runs
    const line = raw.slice(at, nl);
    at = nl + 1;
    consumed = at;
    if (line.trim() === "") continue;
    try {
      records.push(JSON.parse(line) as RolloutRecord);
    } catch {
      // a torn write; skip the line but keep the cursor moving
    }
  }
  return { records, consumed };
}

/**
 * Sessions in the newest date directories. Cheap by construction: only `days` directories are
 * listed, and only `headBytes` of each file is read (session_meta and the first user message
 * both sit at the top). A session with no user message yet has title null — not worth adopting.
 */
export function listCodexSessions(
  codexHome: string,
  opts: { days?: number; now?: Date; headBytes?: number } = {},
): ExternalSession[] {
  const sessionsDir = path.join(codexHome, "sessions");
  const days = opts.days ?? SCAN_DAYS;
  const now = opts.now ?? new Date();
  const out: ExternalSession[] = [];
  for (let back = 0; back < days; back++) {
    const dir = dateDir(sessionsDir, new Date(now.getTime() - back * 24 * 3600 * 1000));
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue; // that day has no directory
    }
    for (const name of names) {
      const m = name.match(FILE_RE);
      if (!m) continue;
      const file = path.join(dir, name);
      let head: string;
      try {
        const fd = fs.openSync(file, "r");
        try {
          // Codex writes ~60-70KB of developer noise (skills listings etc.) BEFORE the first
          // user message (measured), so the window must clear that or every session looks empty
          const buf = Buffer.alloc(opts.headBytes ?? 256 * 1024);
          const n = fs.readSync(fd, buf, 0, buf.length, 0);
          head = buf.subarray(0, n).toString("utf8");
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        continue;
      }
      const { records } = parseLines(head);
      const meta = records.find((r) => r.type === "session_meta")?.payload;
      if (typeof meta?.cwd !== "string") continue;
      const firstUser = records.find((r) => r.type === "event_msg" && r.payload?.type === "user_message");
      const title = typeof firstUser?.payload?.message === "string" ? firstUser.payload.message.slice(0, 60) : null;
      out.push({
        agentSessionId: m[1]!,
        cwd: meta.cwd,
        startedAt: typeof meta.timestamp === "string" ? meta.timestamp : null,
        title,
      });
    }
  }
  return out;
}

/** `<sessions>/YYYY/MM/DD/rollout-*-<threadId>.jsonl` for a known thread, newest dirs first */
export function findCodexRollout(
  codexHome: string,
  threadId: string,
  opts: { days?: number; now?: Date } = {},
): string | null {
  const sessionsDir = path.join(codexHome, "sessions");
  const days = opts.days ?? 14; // an adopted session may be older than the scan window
  const now = opts.now ?? new Date();
  for (let back = 0; back < days; back++) {
    const dir = dateDir(sessionsDir, new Date(now.getTime() - back * 24 * 3600 * 1000));
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const hit = names.find((n) => n.endsWith(`-${threadId}.jsonl`));
    if (hit) return path.join(dir, hit);
  }
  return null;
}

/**
 * Read the rollout from a byte cursor into tiny events. The conversation comes from the event_msg
 * stream (user_message / agent_message) — response_item "message" records also carry role:user
 * entries that nobody typed (plugin notices), the same trap as Claude's isMeta records.
 */
export function readCodexRollout(file: string, sinceCursor: string | null): ExternalRead | null {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return null;
  }
  let from = 0;
  const parsed = sinceCursor ? Number(sinceCursor.replace(/^b:/, "")) : NaN;
  if (Number.isFinite(parsed) && parsed >= 0 && parsed <= size) {
    from = parsed;
  } else if (size > MAX_BACKFILL_BYTES) {
    from = size - MAX_BACKFILL_BYTES;
  }
  let raw: string;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(size - from);
      const n = fs.readSync(fd, buf, 0, buf.length, from);
      raw = buf.subarray(0, n).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  // A mid-file start lands mid-line: drop up to the first newline
  if (from > 0 && !sinceCursor?.startsWith("b:")) {
    const nl = raw.indexOf("\n");
    if (nl < 0) return { events: [], cursor: `b:${from}`, turn: null, title: null };
    raw = raw.slice(nl + 1);
    from += nl + 1;
  }
  const { records, consumed } = parseLines(raw);

  const events: TranscriptEvent[] = [];
  let title: string | null = null;
  // Widened alias: TS narrows the switch-assigned literal to never inside later cases otherwise
  let turn = null as ExternalTurn | null;
  let outputTokens: number | null = null;
  for (const r of records) {
    const p = r.payload ?? {};
    if (r.type === "event_msg") {
      switch (p.type) {
        case "user_message":
          if (typeof p.message === "string" && p.message !== "") {
            events.push({ type: "user_message", payload: { text: p.message } });
            title ??= p.message.slice(0, 60);
          }
          break;
        case "agent_message":
          if (typeof p.message === "string" && p.message !== "") {
            // phase "commentary" is the model narrating its progress — same rule as the app-server adapter
            const type = p.phase === "commentary" ? "assistant_thinking" : "assistant_text";
            events.push({ type, payload: { text: p.message } });
          }
          break;
        case "task_started":
          turn = {
            startedAt: typeof p.started_at === "number" ? new Date(p.started_at * 1000).toISOString() : null,
            outputTokens: null,
            open: true,
          };
          outputTokens = null;
          break;
        case "task_complete":
          // A read can begin mid-turn (the task_started went out with a previous read); the close
          // still must be reported so the running state clears. startedAt null = "keep what you had"
          turn = { startedAt: turn?.startedAt ?? null, outputTokens, open: false };
          break;
        case "token_count": {
          const total = p.info?.total_token_usage?.output_tokens;
          if (typeof total === "number" && Number.isFinite(total)) {
            outputTokens = total;
            // Tokens only flow inside a turn, so seeing them without task_started still means "open"
            turn = { startedAt: turn?.startedAt ?? null, outputTokens: total, open: turn?.open ?? true };
          }
          break;
        }
        default:
          break; // mcp_tool_call_end duplicates the custom_tool_call pair; the rest is bookkeeping
      }
      continue;
    }
    if (r.type === "response_item" && p.type === "custom_tool_call") {
      const input = typeof p.input === "string" ? p.input : JSON.stringify(p.input ?? {});
      events.push({
        type: "tool_started",
        payload: {
          toolName: typeof p.name === "string" ? p.name : "tool",
          toolUseId: typeof p.call_id === "string" ? p.call_id : String(p.id ?? ""),
          input: { input },
          kind: "execute",
          summary: oneLine(input),
        },
      });
      continue;
    }
    if (r.type === "response_item" && p.type === "custom_tool_call_output") {
      if (typeof p.call_id === "string") {
        events.push({ type: "tool_finished", payload: { toolUseId: p.call_id, isError: false, ...toolOutputPayload(p.output) } });
      }
      continue;
    }
    // session_meta / world_state / turn_context / response_item message|reasoning are not conversation
  }
  return { events, cursor: `b:${from + consumed}`, turn, title };
}

/** The current end-of-file cursor, for seeding without importing (never throws) */
export function codexRolloutCursor(file: string): string | null {
  try {
    return `b:${fs.statSync(file).size}`;
  } catch {
    return null;
  }
}

export type LsofRunner = (lockFile: string) => string;
const runLsof: LsofRunner = (lockFile) => {
  const r = spawnSync("lsof", ["-t", "--", lockFile], { encoding: "utf8", timeout: 3000 });
  return typeof r.stdout === "string" ? r.stdout : "";
};

/**
 * Pids holding the thread's writer lock open (measured: codex keeps both the rollout and this
 * lock file open for the whole turn; the file itself outlives the process, so presence alone
 * means nothing — only holders count).
 */
export function codexThreadHolders(codexHome: string, threadId: string, run: LsofRunner = runLsof): number[] {
  const lock = path.join(codexHome, "thread-writer-locks", `${threadId}.lock`);
  if (!fs.existsSync(lock)) return [];
  try {
    return run(lock)
      .split("\n")
      .map((l) => Number(l.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}
