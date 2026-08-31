import path from "node:path";

/**
 * Display hints for tool calls. kind is the ACP ToolKind vocabulary
 * (read / edit / delete / move / search / execute / think / fetch / other) plus tiny's own question.
 * iOS decides a row's look from this vocabulary and summary alone (no need to know per-agent tool names).
 */
export type ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "question" | "other";

export interface ToolHint {
  kind: ToolKind;
  summary: string;
}

const SUMMARY_LIMIT = 120;

/** Normalizes to a single line with a length cap */
export function oneLine(s: string, limit = SUMMARY_LIMIT): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= limit ? t : `${t.slice(0, limit - 1)}…`;
}

function str(input: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = input[k];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return null;
}

function base(p: string): string {
  return path.basename(p);
}

/** Derives kind / summary from a Claude Code tool name and input */
export function describeClaudeTool(name: string, rawInput: unknown): ToolHint {
  const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<string, unknown>;
  const done = (kind: ToolKind, summary: string | null, fallback = name): ToolHint => ({
    kind,
    summary: oneLine(summary ?? fallback),
  });
  switch (name) {
    case "Bash":
      return done("execute", str(input, "description", "command"));
    case "Edit":
    case "Write":
    case "MultiEdit": {
      const p = str(input, "file_path", "path");
      return done("edit", p ? base(p) : null);
    }
    case "NotebookEdit": {
      const p = str(input, "notebook_path", "file_path");
      return done("edit", p ? base(p) : null);
    }
    case "Read": {
      const p = str(input, "file_path", "path");
      return done("read", p ? base(p) : null);
    }
    case "Grep":
    case "Glob":
      return done("search", str(input, "pattern", "query"));
    case "WebFetch":
      return done("fetch", str(input, "url"));
    case "WebSearch":
      return done("fetch", str(input, "query"));
    case "TodoWrite":
      return done("think", "Updated plan");
    case "AskUserQuestion": {
      const qs = Array.isArray(input.questions) ? (input.questions as Record<string, unknown>[]) : [];
      const first = qs[0] ? str(qs[0], "question", "text") : null;
      return done("question", first, "Question");
    }
    default:
      if (name.endsWith("send_user_file")) {
        const p = str(input, "path");
        return done("other", p ? `Sent: ${base(p)}` : "Sent a file");
      }
      return done("other", str(input, "description"));
  }
}
