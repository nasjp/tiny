/**
 * What a tool returned, as text for the phone's tool detail. Every reader and adapter hands its own
 * shape in here (a content string, content blocks, {stdout, stderr}, {output}, {content: [...]})
 * and gets the same payload fields back, so tool_finished carries `output` the same way everywhere
 */

/** Longest output kept on one tool_finished (characters). Beyond it the head is kept and `truncated` says so */
export const TOOL_OUTPUT_LIMIT = 20_000;

export function toolOutputText(x: unknown): string | null {
  if (typeof x === "string") return x.trim() === "" ? null : x;
  if (Array.isArray(x)) {
    const parts: string[] = [];
    for (const b of x) {
      if (b && typeof b === "object" && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string") {
        parts.push((b as { text: string }).text);
      }
    }
    const joined = parts.join("\n");
    return joined.trim() === "" ? null : joined;
  }
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    if (typeof o.stdout === "string" || typeof o.stderr === "string") {
      const out = typeof o.stdout === "string" ? o.stdout : "";
      const err = typeof o.stderr === "string" ? o.stderr : "";
      const both = err.trim() === "" ? out : out.trim() === "" ? err : `${out}\n${err}`;
      return both.trim() === "" ? null : both;
    }
    if (typeof o.output === "string") return toolOutputText(o.output);
    if (Array.isArray(o.content)) return toolOutputText(o.content);
  }
  return null;
}

export function clipToolOutput(text: string): { output: string; truncated?: true } {
  return text.length > TOOL_OUTPUT_LIMIT ? { output: text.slice(0, TOOL_OUTPUT_LIMIT), truncated: true } : { output: text };
}

/** The tool_finished fields for a tool's result: nothing when there is no text to show */
export function toolOutputPayload(x: unknown): { output?: string; truncated?: true } {
  const text = toolOutputText(x);
  return text === null ? {} : clipToolOutput(text);
}
