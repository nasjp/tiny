import fs from "node:fs";
import { toolOutputPayload } from "./tool-output.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { ExternalRead, ExternalSession, ExternalTurn } from "./agent-storage.js";
import type { TranscriptEvent } from "./claude-transcript.js";
import { oneLine, type ToolKind } from "./tool-kinds.js";

/**
 * Read-only readers for Codex's own storage (UNDOCUMENTED interfaces, measured 2026-09-01 on
 * codex-cli 0.149.1 and 2026-09-06 on 0.153.4 — see HANDOFF "Step 3"):
 *   <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<ISO>-<threadId>.jsonl   append-only transcript
 *   <CODEX_HOME>/thread-writer-locks/<threadId>.lock                  held open (lsof-visible) while a writer runs
 * Everything here degrades to null / empty — a broken or missing file means "cannot tell", never a throw.
 *
 * Two rollout formats exist, told apart by `session_meta.history_mode`:
 *   "legacy"    — the conversation is `event_msg` user_message / agent_message, tools are the
 *                 `response_item` custom_tool_call / custom_tool_call_output pair
 *                 (TUI < 0.147.0, `codex exec` < 0.149.x, `codex app-server` ≤ 0.149.1)
 *   "paginated" — the conversation and the tools are `event_msg` item_completed records carrying
 *                 PascalCase items (UserMessage / AgentMessage / CommandExecution / …); the
 *                 custom_tool_call pair is still written but is the unified-exec JS wrapper (one
 *                 call runs several commands), so it must NOT be shown next to the items
 *                 (TUI ≥ 0.147.0 = 2026-08-11 on this Mac, app-server ≥ 0.153.x)
 * task_started / task_complete / token_count are the same in both.
 */

/** ~/.codex/sessions can hold 13GB+; only date directories this recent are ever scanned */
const SCAN_DAYS = 2;
/** A first import of a huge rollout starts this far from the end instead of at byte 0 */
const MAX_BACKFILL_BYTES = 512 * 1024;
/**
 * How much of a file's head holds session_meta and the first user message. Codex writes ~60-110KB
 * of developer noise (skills listings, AGENTS.md) BEFORE the first user message (measured 0.149 /
 * 0.153), so the window must clear that or every session looks empty
 */
const HEAD_BYTES = 256 * 1024;

type RolloutFormat = "legacy" | "paginated";

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

/** The first `bytes` of a file as text; null when it cannot be read */
function readHead(file: string, bytes: number): string | null {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(bytes);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, n).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function formatOfMeta(meta: Record<string, any> | undefined): RolloutFormat | null {
  if (meta?.history_mode === "paginated") return "paginated";
  if (typeof meta?.history_mode === "string") return "legacy";
  return null;
}

/** The format declared by the file's session_meta (its first line); null when it cannot be told */
function headFormat(file: string): RolloutFormat | null {
  const head = readHead(file, HEAD_BYTES);
  if (head === null) return null;
  const nl = head.indexOf("\n");
  if (nl < 0) return null;
  try {
    const first = JSON.parse(head.slice(0, nl)) as RolloutRecord;
    return first.type === "session_meta" ? formatOfMeta(first.payload) : null;
  } catch {
    return null;
  }
}

/**
 * A thread another thread spawned (measured: `thread_source: "subagent"`, `source: {subagent: …}`,
 * `parent_thread_id`). It shares the sessions directory but nobody typed into it
 */
function isSubagentThread(meta: Record<string, any>): boolean {
  if (meta.thread_source === "subagent") return true;
  const src = meta.source;
  return !!src && typeof src === "object" && "subagent" in (src as Record<string, unknown>);
}

/** Text parts of an item's content ([{type: "text" | "Text", text}]); other parts (images) are skipped */
function itemText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    const part = c as { type?: unknown; text?: unknown };
    if (typeof part.text === "string" && String(part.type ?? "text").toLowerCase() === "text") parts.push(part.text);
  }
  return parts.join("\n");
}

function isUserMessageItem(r: RolloutRecord): boolean {
  return r.type === "event_msg" && r.payload?.type === "item_completed" && r.payload.item?.type === "UserMessage";
}

/** A session title from what the person said: one line, at most 60 characters */
function titleOf(text: string): string {
  return oneLine(text, 60);
}

/** What the person said first, in either format; null when nothing yet */
function firstUserText(records: RolloutRecord[]): string | null {
  for (const r of records) {
    if (r.type !== "event_msg") continue;
    if (r.payload?.type === "user_message" && typeof r.payload.message === "string" && r.payload.message !== "") return r.payload.message;
    if (isUserMessageItem(r)) {
      const text = itemText(r.payload!.item.content);
      if (text !== "") return text;
    }
  }
  return null;
}

/**
 * Sessions in the newest date directories. Cheap by construction: only `days` directories are
 * listed, and only `headBytes` of each file is read (session_meta and the first user message
 * both sit at the top). A session with no user message yet has title null — not worth adopting;
 * sub-agent threads are left out altogether.
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
      const head = readHead(path.join(dir, name), opts.headBytes ?? HEAD_BYTES);
      if (head === null) continue;
      const { records } = parseLines(head);
      const meta = records.find((r) => r.type === "session_meta")?.payload;
      if (typeof meta?.cwd !== "string") continue;
      if (isSubagentThread(meta)) continue;
      const text = firstUserText(records);
      out.push({
        agentSessionId: m[1]!,
        cwd: meta.cwd,
        startedAt: typeof meta.timestamp === "string" ? meta.timestamp : null,
        title: text === null ? null : titleOf(text),
      });
    }
  }
  return out;
}

/** `["/bin/zsh", "-lc", script]` (paginated) or `/bin/zsh -lc 'script'` (app-server) → the script */
function shellScript(command: unknown): string {
  if (Array.isArray(command)) {
    const parts = command.filter((c): c is string => typeof c === "string");
    if (parts.length >= 3 && /\/(sh|bash|zsh|fish)$/.test(parts[0]!) && /^-l?c$/.test(parts[1]!)) return parts.slice(2).join(" ");
    return parts.join(" ");
  }
  if (typeof command === "string") {
    const m = /^\/bin\/\w+ -lc ['"]([\s\S]*)['"]$/.exec(command);
    return m ? m[1]! : command;
  }
  return "";
}

/** CommandExecution.cwd is a file:// URL (measured); plain paths pass through */
function cwdOf(v: unknown): string | null {
  if (typeof v !== "string" || v === "") return null;
  if (!v.startsWith("file://")) return v;
  try {
    return fileURLToPath(v);
  } catch {
    return v.slice("file://".length);
  }
}

/** Reasoning items carry summary_text / raw_content as strings or {text} entries (measured empty on current defaults) */
function reasoningText(item: Record<string, any>): string {
  const pick = (v: unknown): string =>
    Array.isArray(v)
      ? v
          .map((e) => (typeof e === "string" ? e : e && typeof e === "object" && typeof (e as { text?: unknown }).text === "string" ? (e as { text: string }).text : ""))
          .filter((t) => t !== "")
          .join("\n")
      : "";
  return (pick(item.summary_text) || pick(item.raw_content)).trim();
}

function toolPair(
  id: string,
  info: { toolName: string; kind: ToolKind; input: Record<string, unknown>; summary: string },
  isError: boolean,
  output: unknown,
): TranscriptEvent[] {
  return [
    { type: "tool_started", payload: { toolName: info.toolName, toolUseId: id, input: info.input, kind: info.kind, summary: oneLine(info.summary) } },
    { type: "tool_finished", payload: { toolUseId: id, isError, ...toolOutputPayload(output) } },
  ];
}

/**
 * A paginated `item_completed` item → tiny events. Item types mirror what the app-server adapter
 * shows for the same turn (commandExecution / fileChange / mcpToolCall / webSearch), so a session
 * looks the same whether tiny ran the turn or watched the terminal run it
 */
function eventsOfItem(item: Record<string, any>): TranscriptEvent[] {
  const id = typeof item.id === "string" ? item.id : "";
  switch (item.type) {
    case "UserMessage": {
      const text = itemText(item.content);
      return text === "" ? [] : [{ type: "user_message", payload: { text } }];
    }
    case "AgentMessage": {
      const text = itemText(item.content);
      if (text === "") return [];
      // phase "commentary" is the model narrating its progress — same rule as the app-server adapter
      return [{ type: item.phase === "commentary" ? "assistant_thinking" : "assistant_text", payload: { text } }];
    }
    case "Reasoning": {
      const text = reasoningText(item);
      return text === "" ? [] : [{ type: "assistant_thinking", payload: { text } }];
    }
    case "CommandExecution": {
      if (id === "") return [];
      const command = shellScript(item.command);
      const cwd = cwdOf(item.cwd);
      const failed = item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0);
      const output = item.aggregated_output ?? item.formatted_output ?? { stdout: item.stdout, stderr: item.stderr };
      return toolPair(id, { toolName: "commandExecution", kind: "execute", input: { command, ...(cwd ? { cwd } : {}) }, summary: command || "commandExecution" }, failed, output);
    }
    case "FileChange": {
      if (id === "") return [];
      const raw = item.changes && typeof item.changes === "object" ? (item.changes as Record<string, { type?: unknown }>) : {};
      const changes = Object.entries(raw).map(([p, c]) => ({ path: p, type: typeof c?.type === "string" ? c.type : "update" }));
      const first = changes[0] ? path.basename(changes[0].path) : "files";
      const more = changes.length > 1 ? ` +${changes.length - 1} files` : "";
      return toolPair(id, { toolName: "fileChange", kind: "edit", input: { changes }, summary: first + more }, item.status === "failed", null);
    }
    case "McpToolCall": {
      if (id === "") return [];
      const toolName = `${typeof item.server === "string" ? item.server : "mcp"}_${typeof item.tool === "string" ? item.tool : "tool"}`;
      const args = (item.arguments && typeof item.arguments === "object" ? item.arguments : {}) as Record<string, unknown>;
      const file = typeof args.path === "string" ? path.basename(args.path) : null;
      const summary = item.tool === "send_user_file" ? `Sent: ${file ?? "a file"}` : toolName;
      const failed = item.status === "failed" || item.result?.isError === true;
      return toolPair(id, { toolName, kind: "other", input: args, summary }, failed, item.result);
    }
    case "Extension": {
      if (id === "" || item.kind !== "web.search") return []; // other extensions are not shown yet
      const query = typeof item.query === "string" ? item.query : typeof item.action?.query === "string" ? item.action.query : "";
      return toolPair(id, { toolName: "webSearch", kind: "fetch", input: { query }, summary: query || "webSearch" }, item.status === "failed", null);
    }
    default:
      return []; // ImageView / ContextCompaction / …
  }
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
 * stream (user_message / agent_message, or item_completed in the paginated format) —
 * response_item "message" records also carry role:user entries that nobody typed (AGENTS.md,
 * plugin notices), the same trap as Claude's isMeta records.
 */
export function readCodexRollout(
  file: string,
  sinceCursor: string | null,
  opts: {
    /** client_ids of UserMessages tiny itself queued: reported in peerMsgIds but not emitted (they are already in the conversation) */
    skipPeerMsgIds?: ReadonlySet<string>;
  } = {},
): ExternalRead | null {
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
    if (nl < 0) return { events: [], cursor: `b:${from}`, turn: null, title: null, peerMsgIds: [] };
    raw = raw.slice(nl + 1);
    from += nl + 1;
  }
  const { records, consumed } = parseLines(raw);

  // Which format this file is in decides whether the custom_tool_call pair is a tool (legacy) or
  // the unified-exec wrapper around items that are shown on their own (paginated). The meta line
  // is in the window on a first read from byte 0; otherwise it is one small read away
  const metaInWindow = records.find((r) => r.type === "session_meta")?.payload;
  const declared = metaInWindow ? formatOfMeta(metaInWindow) : headFormat(file);
  const paginated = declared === "paginated" || records.some((r) => r.type === "event_msg" && r.payload?.type === "item_completed");

  const events: TranscriptEvent[] = [];
  const peerMsgIds: string[] = [];
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
            title ??= titleOf(p.message);
          }
          break;
        case "agent_message":
          if (typeof p.message === "string" && p.message !== "") {
            // phase "commentary" is the model narrating its progress — same rule as the app-server adapter
            const type = p.phase === "commentary" ? "assistant_thinking" : "assistant_text";
            events.push({ type, payload: { text: p.message } });
          }
          break;
        case "item_completed": {
          const item = p.item && typeof p.item === "object" ? (p.item as Record<string, any>) : null;
          if (!item) break;
          const evs = eventsOfItem(item);
          if (item.type === "UserMessage") {
            if (evs[0]) title ??= titleOf((evs[0].payload as { text: string }).text);
            // The id the sender attached (thread/queue/add's clientUserMessageId lands here verbatim)
            if (typeof item.client_id === "string" && item.client_id !== "") {
              peerMsgIds.push(item.client_id);
              if (opts.skipPeerMsgIds?.has(item.client_id)) break; // tiny's own message coming back
            }
          }
          events.push(...evs);
          break;
        }
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
    if (paginated) continue; // tools already came in as items; the custom_tool_call pair is their wrapper
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
  return { events, cursor: `b:${from + consumed}`, turn, title, peerMsgIds };
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
