import fs from "node:fs";
import path from "node:path";

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
 * Read a Claude Code transcript into Tiny events.
 * `sinceUuid` resumes after a previous read; `limit` caps a first read (newest kept).
 */
export function readTranscript(
  file: string,
  opts: { sinceUuid?: string | null; limit?: number } = {},
): TranscriptRead {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { events: [], title: null, cursor: null };
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

  let title: string | null = null;
  for (const r of records) {
    if (r.type === "ai-title" && typeof r.aiTitle === "string" && r.aiTitle !== "") title = r.aiTitle;
  }

  // Only user/assistant records carry conversation. Everything else is bookkeeping
  const messages = records.filter((r) => r.type === "user" || r.type === "assistant");

  let slice = messages;
  if (opts.sinceUuid) {
    const at = messages.findIndex((r) => r.uuid === opts.sinceUuid);
    slice = at >= 0 ? messages.slice(at + 1) : messages;
  } else if (opts.limit !== undefined && messages.length > opts.limit) {
    slice = messages.slice(messages.length - opts.limit);
  }

  const events: TranscriptEvent[] = [];
  for (const r of slice) {
    const message = (r.message ?? {}) as Record<string, unknown>;
    if (r.type === "user") {
      const text = textOf(message.content);
      if (text !== null) {
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
        events.push({
          type: "tool_started",
          payload: { toolName: b.name, toolUseId: b.id, input: b.input ?? {} },
        });
      }
    }
  }

  if (title === null) {
    const firstUser = slice.find((r) => r.type === "user");
    const t = firstUser ? textOf((firstUser.message as Record<string, unknown>)?.content) : null;
    title = t ? t.slice(0, 60) : null;
  }

  const last = messages[messages.length - 1];
  const cursor = last && typeof last.uuid === "string" ? last.uuid : null;
  return { events, title, cursor };
}
