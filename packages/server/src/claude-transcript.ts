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
  /**
   * msg_ids of messages other processes injected through the CLI's messaging socket (records with
   * origin.kind "peer"). They are isMeta and never become events; a live turn matches its own id here
   * to learn the CLI accepted the message
   */
  peerMsgIds: string[];
  /** The newest turn's progress, or null when the transcript holds no turn yet */
  turn: TranscriptTurn | null;
}

/**
 * Progress of the newest turn in a transcript — what Claude Code's own status line shows as
 * "(5m 58s · ↓ 16.4k tokens)". Computed over the whole file, independent of the import cursor.
 */
export interface TranscriptTurn {
  /** Timestamp of the record that started the turn (ISO 8601), null when it carries none */
  startedAt: string | null;
  /** Output tokens across the API responses since then, each response counted once */
  outputTokens: number;
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

/**
 * Messages from other Claude sessions (SendMessage between terminals, agent teams) arrive as plain
 * user records — no isMeta, no promptSource — shaped as an optional header line, one XML wrapper
 * whose attributes name the sender, and a footer of guidance for the model. Only the wrapper's
 * body is conversation. The header wording and the wrapper tags are Claude Code's (2.1.251).
 */
const PEER_HEADER_RE = /^(?:Another Claude session sent a message|A peer session sent a message)[^\n]*:\n/;
const PEER_TAGS = new Set(["teammate-message", "cross-session-message", "agent-message", "coordinator-relay"]);
const TAG_BLOCK_RE = /^<([a-z][\w-]*)((?:\s[^>]*)?)>\n?([\s\S]*?)\n?<\/\1>/;

export interface PeerMessage {
  from: string;
  summary?: string;
  text: string;
}

/**
 * Agent teams inject their notifications as a JSON blob inside the wrapper — the phone showed
 * `{"type":"idle_notification","from":...,"result":"…\n\n要点:…"}` verbatim, escapes and all
 * (device report). Pull out the part written for a person and name the notification kind; keep
 * anything unrecognised complete, just laid out instead of printed on one line.
 */
function humanizePeerBody(body: string): { from?: string; summary?: string; text: string } | null {
  if (!body.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null; // a body that merely starts with a brace is a body
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  const str = (k: string): string | null => {
    const v = o[k];
    return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  };
  const from = str("from") ?? undefined;
  const kind = str("type");
  const summary = kind === "idle_notification" ? "Went idle" : (kind?.replace(/_/g, " ") ?? undefined);
  const human = str("result") ?? str("message") ?? str("text") ?? str("body");
  if (human) return { ...(from ? { from } : {}), ...(summary ? { summary } : {}), text: human };
  // Nothing was written for a person. Say what happened rather than showing the wire
  if (kind === "idle_notification") {
    const reason = str("idleReason");
    return { ...(from ? { from } : {}), text: reason ? `Went idle (${reason})` : "Went idle" };
  }
  return { ...(from ? { from } : {}), ...(summary ? { summary } : {}), text: JSON.stringify(o, null, 2) };
}

function parsePeerMessage(text: string): PeerMessage | null {
  let t = text.trimStart();
  const header = t.match(PEER_HEADER_RE);
  if (header) t = t.slice(header[0].length).trimStart();
  if (!t.startsWith("<")) return null;
  const m = t.match(TAG_BLOCK_RE);
  // Without the header, only the known wrapper tags count — a person may well start a message with a tag
  if (!m || (!header && !PEER_TAGS.has(m[1]!))) return null;
  const attrs: Record<string, string> = {};
  for (const a of m[2]!.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]!] = a[2]!;
  // Claude Code escapes a closing tag inside the body as `<\/tag` so the wrapper stays unambiguous
  const body = m[3]!.replace(/<\\\//g, "</").trim();
  const humanized = humanizePeerBody(body);
  const from = attrs.teammate_id ?? attrs["from-name"] ?? attrs.from ?? humanized?.from ?? "another session";
  // The sender's own summary attribute was written by hand; it wins over the kind we name
  const summary = attrs.summary ?? humanized?.summary;
  return { from, ...(summary ? { summary } : {}), text: humanized?.text ?? body };
}

/**
 * A slash command is recorded as a `<command-name>` record (what the person typed) followed by a
 * `<local-command-stdout>` record (Claude Code's terminal output). Skill invocations put
 * `<command-message>` first. The typed line is conversation; the output is not.
 */
function parseSlashCommand(text: string): string | null {
  if (!text.startsWith("<command-name>") && !text.startsWith("<command-message>")) return null;
  const name = text.match(/<command-name>([^<]*)<\/command-name>/)?.[1]?.trim();
  const message = text.match(/<command-message>([^<]*)<\/command-message>/)?.[1]?.trim();
  const args = text.match(/<command-args>([^<]*)<\/command-args>/)?.[1]?.trim();
  const head = name || (message ? `/${message}` : null);
  if (!head) return null;
  return args ? `${head} ${args}` : head;
}

/** Records Claude Code writes as user records that carry nothing a person said or should see */
function isHarnessNoise(text: string): boolean {
  return text.startsWith("<local-command-stdout>") || text.startsWith("<local-command-stderr>") ||
    text.startsWith("<task-notification>");
}

type UserText =
  | { kind: "human"; text: string }
  | { kind: "bash-input"; command: string }
  | { kind: "bash-output"; isError: boolean }
  | { kind: "peer"; message: PeerMessage }
  | { kind: "command"; text: string }
  | { kind: "noise" };

function classifyUserText(text: string): UserText {
  const command = parseBashInput(text);
  if (command !== null) return { kind: "bash-input", command };
  const output = parseBashOutput(text);
  if (output !== null) return { kind: "bash-output", isError: output.isError };
  if (isHarnessNoise(text)) return { kind: "noise" };
  const slash = parseSlashCommand(text);
  if (slash !== null) return { kind: "command", text: slash };
  const peer = parsePeerMessage(text);
  if (peer !== null) return { kind: "peer", message: peer };
  return { kind: "human", text };
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
  // Bash blocks, slash commands, peer messages and harness notices are not a person talking —
  // none of them count toward the backfill window or may title a session
  return classifyUserText(text).kind === "human";
}

/**
 * A user record that starts a turn of the agent: something the person typed (a message or a slash
 * command), or a message another process injected through the messaging socket (tiny's own live
 * turns, other Claude sessions). Bash blocks, harness notices and the isMeta bookkeeping Claude Code
 * writes mid-turn (caveats, skill bodies) do not start one — counting those would cut a turn's
 * token total in half at the first `<task-notification>`
 */
function startsTurn(r: Record<string, unknown>): boolean {
  if (r.type !== "user") return false;
  const text = textOf((r.message as Record<string, unknown> | undefined)?.content);
  if (text === null) return false;
  if (r.isMeta === true) {
    const origin = r.origin as { kind?: unknown } | undefined;
    return origin?.kind === "peer";
  }
  const kind = classifyUserText(text).kind;
  return kind === "human" || kind === "command" || kind === "peer";
}

/**
 * Progress of the newest turn: the timestamp of the record that started it and the output tokens
 * written since. Claude Code repeats one API response's `usage` on every record of that response
 * (a thinking, a text and a tool_use record all carry output_tokens: 363), so responses are
 * counted once by message id
 */
export function newestTurn(messages: Array<Record<string, unknown>>): TranscriptTurn | null {
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (startsTurn(messages[i]!)) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const first = messages[start]!;
  const byResponse = new Map<string, number>();
  let anonymous = 0;
  for (const r of messages.slice(start + 1)) {
    if (r.type !== "assistant") continue;
    const message = r.message as { id?: unknown; usage?: { output_tokens?: unknown } } | undefined;
    const out = message?.usage?.output_tokens;
    if (typeof out !== "number" || !Number.isFinite(out)) continue;
    const key = typeof message?.id === "string" ? message.id : `#${anonymous++}`;
    byResponse.set(key, Math.max(byResponse.get(key) ?? 0, out));
  }
  let outputTokens = 0;
  for (const n of byResponse.values()) outputTokens += n;
  return { startedAt: typeof first.timestamp === "string" ? first.timestamp : null, outputTokens };
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
  if (records === null) return { events: [], title: null, cursor: null, peerMsgIds: [], turn: null };

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
  const peerMsgIds: string[] = [];
  // Pairs a <bash-input> record's uuid with its <bash-stdout> record by position: the stdout record
  // follows its input record. A stdout with nothing pending (e.g. a backfill window cutting between
  // the two) is dropped rather than emitted as an orphan tool_finished
  let pendingBashUuid: string | null = null;
  for (const r of slice) {
    // Claude Code's own interjections (the "Caveat: The messages below were generated by the user
    // while running local commands" preamble and its kin). Nobody typed them, and showing them as
    // a user message reads on the phone as something the person said. Skipped like any other
    // bookkeeping record — but left in `messages`, so a cursor pointing at one still resolves
    if (r.type === "user") {
      const origin = r.origin as { kind?: unknown; msg_id?: unknown } | undefined;
      if (origin?.kind === "peer" && typeof origin.msg_id === "string") peerMsgIds.push(origin.msg_id);
    }
    if (r.isMeta === true) continue;
    const message = (r.message ?? {}) as Record<string, unknown>;
    if (r.type === "user") {
      const text = textOf(message.content);
      if (text !== null) {
        const u = classifyUserText(text);
        switch (u.kind) {
          case "bash-input": {
            const hint = describeClaudeTool("Bash", { command: u.command });
            pendingBashUuid = typeof r.uuid === "string" ? r.uuid : null;
            events.push({
              type: "tool_started",
              payload: {
                toolName: "Bash",
                toolUseId: pendingBashUuid,
                input: { command: u.command },
                kind: hint.kind,
                summary: hint.summary,
              },
            });
            break;
          }
          case "bash-output":
            if (pendingBashUuid !== null) {
              events.push({ type: "tool_finished", payload: { toolUseId: pendingBashUuid, isError: u.isError } });
              pendingBashUuid = null;
            }
            break;
          case "peer":
            events.push({ type: "peer_message", payload: { ...u.message } });
            break;
          case "command":
            events.push({ type: "user_message", payload: { text: u.text } });
            break;
          case "noise":
            break;
          case "human":
            events.push({ type: "user_message", payload: { text: u.text } });
            break;
        }
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
      // What Claude Code's terminal shows as the model's progress narration ("· summarized"). Fable 5
      // records ordinary thinking with an empty body and only these narration blocks with text, so
      // "non-empty" is the whole distinction; older models put their full reasoning here, and that
      // is shown too, as the terminal does
      if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim() !== "") {
        events.push({ type: "assistant_thinking", payload: { text: b.thinking } });
      }
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

  return { events, title, cursor: cursorOf(messages), peerMsgIds, turn: newestTurn(messages) };
}
