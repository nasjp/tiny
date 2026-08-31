import fs from "node:fs";
import path from "node:path";
import { describeClaudeTool } from "./tool-kinds.js";

export interface TranscriptEvent {
  type: string;
  payload: Record<string, unknown>;
}

export interface TranscriptRead {
  events: TranscriptEvent[];
  /** Session title from the transcript. null when it cannot be derived */
  title: string | null;
  /** uuid of the last record read. Pass it back as sinceUuid next time */
  cursor: string | null;
}

/** Claude Code encodes the cwd by replacing "/" and "." with "-" */
function encodeCwd(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/**
 * Locate `<configDir>/projects/<encoded-cwd>/<agentSessionId>.jsonl`.
 * The encoding is not documented, so fall back to scanning projects/ one level deep.
 */
export function findTranscript(configDir: string, cwd: string, agentSessionId: string): string | null {
  const projects = path.join(configDir, "projects");
  const direct = path.join(projects, encodeCwd(cwd), `${agentSessionId}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projects, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const f = path.join(projects, d, `${agentSessionId}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function textOf(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .filter((b): b is { type: string; text: string } =>
      typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text" &&
      typeof (b as { text?: unknown }).text === "string")
    .map((b) => b.text);
  return parts.length > 0 ? parts.join("\n") : null;
}

function blocks(content: unknown): Array<Record<string, unknown>> {
  return Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
}

/**
 * `!cmd` in Claude Code is recorded as plain user records — no isMeta, no promptSource, nothing
 * marking them as special. They are an operation log ("Ran 1 command" in Claude Code's own UI),
 * not something the person said, so they must not reach the client as user_message. Anchored on
 * the content starting with the tag, so a sentence that merely mentions "<bash-input>" is untouched.
 */
const BASH_INPUT_RE = /^<bash-input>([\s\S]*)<\/bash-input>\s*$/;
const BASH_OUTPUT_RE = /^<bash-stdout>[\s\S]*?<\/bash-stdout><bash-stderr>([\s\S]*?)<\/bash-stderr>\s*$/;

function parseBashInput(text: string): string | null {
  if (!text.startsWith("<bash-input>")) return null;
  const m = text.match(BASH_INPUT_RE);
  return m ? m[1]! : null;
}

function parseBashOutput(text: string): { isError: boolean } | null {
  if (!text.startsWith("<bash-stdout>")) return null;
  const m = text.match(BASH_OUTPUT_RE);
  return m ? { isError: m[1]!.length > 0 } : null;
}

/** Backstop for a first read: one turn can carry hundreds of tool records */
const DEFAULT_MAX_RECORDS = 300;

function parseRecords(file: string): Array<Record<string, unknown>> | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const records: Array<Record<string, unknown>> = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      records.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // A partially written last line is normal while the CLI is running
    }
  }
  return records;
}

/** Only user/assistant records carry conversation. Everything else is bookkeeping */
function messagesOf(records: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return records.filter((r) => r.type === "user" || r.type === "assistant");
}

function cursorOf(messages: Array<Record<string, unknown>>): string | null {
  const last = messages[messages.length - 1];
  return last && typeof last.uuid === "string" ? last.uuid : null;
}

/**
 * The transcript's current tail, without producing any events.
 * Lets a caller move its cursor past records it already knows about.
 */
export function readTranscriptCursor(file: string): string | null {
  const records = parseRecords(file);
  return records === null ? null : cursorOf(messagesOf(records));
}

/**
 * A user record that carries something the person actually typed. Excludes records holding only
 * tool_result blocks, and isMeta records (Claude Code writes 1-9 of those into every transcript).
 */
function startsHumanTurn(r: Record<string, unknown>): boolean {
  if (r.type !== "user" || r.isMeta === true) return false;
  const text = textOf((r.message as Record<string, unknown> | undefined)?.content);
  if (text === null) return false;
  // A `!cmd` block is operation log, not a person talking — must not count toward the backfill window
  return parseBashInput(text) === null && parseBashOutput(text) === null;
}

/**
 * The newest `turns` human turns, capped at `maxRecords` (newest kept). The record that starts the
 * oldest kept turn is included: cutting after it would strand a tool_finished whose tool_started
 * never made it in. Slicing by record count instead would fill a first import with nothing but tool
 * traffic — a real turn runs 10-35 records, most of them tool_use / tool_result.
 */
export function sliceRecentTurns(
  messages: Array<Record<string, unknown>>,
  turns: number,
  maxRecords: number = DEFAULT_MAX_RECORDS,
): Array<Record<string, unknown>> {
  let start = 0;
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!startsHumanTurn(messages[i]!)) continue;
    seen += 1;
    if (seen === turns) {
      start = i;
      break;
    }
  }
  const slice = messages.slice(start);
  return slice.length > maxRecords ? slice.slice(slice.length - maxRecords) : slice;
}

/**
 * Read a Claude Code transcript into Tiny events.
 * `sinceUuid` resumes after a previous read; `turns` caps a first read to the newest human turns.
 */
export function readTranscript(
  file: string,
  opts: { sinceUuid?: string | null; turns?: number; maxRecords?: number } = {},
): TranscriptRead {
  const records = parseRecords(file);
  if (records === null) return { events: [], title: null, cursor: null };

  let title: string | null = null;
  for (const r of records) {
    if (r.type === "ai-title" && typeof r.aiTitle === "string" && r.aiTitle !== "") title = r.aiTitle;
  }

  const messages = messagesOf(records);

  let slice = messages;
  if (opts.sinceUuid) {
    const at = messages.findIndex((r) => r.uuid === opts.sinceUuid);
    // Cursor not found: the transcript was forked or rotated. Importing everything again would
    // duplicate the whole conversation for the caller, so import nothing and let the cursor advance
    slice = at >= 0 ? messages.slice(at + 1) : [];
  } else if (opts.turns !== undefined) {
    slice = sliceRecentTurns(messages, opts.turns, opts.maxRecords);
  }

  const events: TranscriptEvent[] = [];
  // Pairs a <bash-input> record's uuid with its <bash-stdout> record by position: the stdout record
  // follows its input record. A stdout with nothing pending (e.g. a backfill window cutting between
  // the two) is dropped rather than emitted as an orphan tool_finished
  let pendingBashUuid: string | null = null;
  for (const r of slice) {
    // Claude Code's own interjections (the "Caveat: The messages below were generated by the user
    // while running local commands" preamble and its kin). Nobody typed them, and showing them as
    // a user message reads on the phone as something the person said. Skipped like any other
    // bookkeeping record — but left in `messages`, so a cursor pointing at one still resolves
    if (r.isMeta === true) continue;
    const message = (r.message ?? {}) as Record<string, unknown>;
    if (r.type === "user") {
      const text = textOf(message.content);
      if (text !== null) {
        const command = parseBashInput(text);
        if (command !== null) {
          const hint = describeClaudeTool("Bash", { command });
          pendingBashUuid = typeof r.uuid === "string" ? r.uuid : null;
          events.push({
            type: "tool_started",
            payload: {
              toolName: "Bash",
              toolUseId: pendingBashUuid,
              input: { command },
              kind: hint.kind,
              summary: hint.summary,
            },
          });
          continue;
        }
        const output = parseBashOutput(text);
        if (output !== null) {
          if (pendingBashUuid !== null) {
            events.push({ type: "tool_finished", payload: { toolUseId: pendingBashUuid, isError: output.isError } });
            pendingBashUuid = null;
          }
          continue;
        }
        events.push({ type: "user_message", payload: { text } });
        continue;
      }
      for (const b of blocks(message.content)) {
        if (b.type === "tool_result") {
          events.push({
            type: "tool_finished",
            payload: { toolUseId: b.tool_use_id, isError: b.is_error ?? false },
          });
        }
      }
      continue;
    }
    for (const b of blocks(message.content)) {
      if (b.type === "text" && typeof b.text === "string" && b.text !== "") {
        events.push({ type: "assistant_text", payload: { text: b.text } });
      }
      if (b.type === "tool_use") {
        const hint = describeClaudeTool(String(b.name ?? ""), b.input);
        events.push({
          type: "tool_started",
          payload: {
            toolName: b.name,
            toolUseId: b.id,
            input: b.input ?? {},
            kind: hint.kind,
            summary: hint.summary,
          },
        });
      }
    }
  }

  if (title === null) {
    const firstUser = slice.find(startsHumanTurn);
    const t = firstUser ? textOf((firstUser.message as Record<string, unknown>)?.content) : null;
    title = t ? t.slice(0, 60) : null;
  }

  return { events, title, cursor: cursorOf(messages) };
}
