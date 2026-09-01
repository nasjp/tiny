import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { toolOutputPayload } from "./tool-output.js";
import type { CanUseTool, McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { AgentAdapter, RunTurnParams, TurnResult } from "./adapter.js";
import { claudeConfigDirEnv } from "./agents/claude.js";
import { describeClaudeTool } from "./tool-kinds.js";

type QueryFn = typeof sdkQuery;

// Actual canUseTool signature (verified in node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts):
//   type CanUseTool = (toolName: string, input: Record<string, unknown>, options: {...}) => Promise<PermissionResult | null>
// This SDK version has no "new form" (single request object), so we support the legacy form only.
function makeCanUseTool(p: RunTurnParams): CanUseTool {
  return async (toolName, input) => {
    const d = await p.requestPermission(toolName, input, describeClaudeTool(toolName, input));
    // For AskUserQuestion, the client writes the answers into input.answers and returns it.
    // A plain allow without updatedInput returns the original input unchanged
    return d.behavior === "allow"
      ? { behavior: "allow", updatedInput: d.updatedInput ?? input }
      : { behavior: "deny", message: d.message };
  };
}

type SdkPermissionMode = "default" | "acceptEdits" | "bypassPermissions";
const SDK_PERMISSION_MODES: readonly SdkPermissionMode[] = ["default", "acceptEdits", "bypassPermissions"];

/** Map tiny's permission mode (string) to the SDK type. Assumed pre-validated by the driver's capabilities, but fall back to default on mismatch */
function toSdkPermissionMode(mode: string): SdkPermissionMode {
  return (SDK_PERMISSION_MODES as readonly string[]).includes(mode) ? (mode as SdkPermissionMode) : "default";
}

/**
 * Drops keys whose value is undefined, so "remove this variable" really is removal.
 * The SDK replaces the child env wholesale with options.env (`env = options.env ? {...options.env}
 * : {...process.env}`), so a key that is absent here is absent from the agent process
 */
export function definedEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

function contentBlocks(msg: Record<string, any>): Array<Record<string, any>> {
  const m = msg.message;
  if (Array.isArray(m?.content)) return m.content;
  if (Array.isArray(m)) return m;
  return [];
}

export class ClaudeAdapter implements AgentAdapter {
  constructor(private queryFn: QueryFn = sdkQuery) {}

  async runTurn(p: RunTurnParams): Promise<TurnResult> {
    // send_user_file is provided by `tiny mcp-server` (stdio), launched with session-specific env.
    // We dropped the in-process SDK MCP to share the same path as the other agents (ACP / Codex)
    const mcpServers: Record<string, McpServerConfig> = p.mcpServer
      ? { tiny: { type: "stdio", command: p.mcpServer.command, args: p.mcpServer.args, env: p.mcpServer.env } }
      : {};
    const allowedTools = p.mcpServer ? ["mcp__tiny__send_user_file"] : [];

    const abort = new AbortController();
    const onAbort = () => abort.abort();
    p.signal.addEventListener("abort", onAbort);
    if (p.signal.aborted) abort.abort();

    let agentSessionId = p.agentSessionId;
    let costUsd: number | null = null;
    let resultText: string | null = null;

    try {
      // Prompts with images are passed as an AsyncIterable user message (content blocks).
      // A string prompt cannot carry images (SDK limitation)
      const promptInput =
        p.images && p.images.length > 0
          ? (async function* (images: NonNullable<typeof p.images>, text: string) {
              yield {
                type: "user" as const,
                parent_tool_use_id: null,
                message: {
                  role: "user" as const,
                  content: [
                    ...images.map((img) => ({
                      type: "image" as const,
                      source: { type: "base64" as const, media_type: img.mediaType, data: img.data },
                    })),
                    { type: "text" as const, text },
                  ],
                },
              };
            })(p.images, p.prompt)
          : p.prompt;

      const q = this.queryFn({
        prompt: promptInput,
        options: {
          cwd: p.cwd,
          // Always drop ANTHROPIC_API_KEY: leaving it switches billing from the subscription to metered API usage.
          // TINY_SESSION_ID: hooks in the user's own settings.json run inside this agent and inherit its
          // env, and `tiny handoff` reads it to recognize that it is inside an agent tiny started and do
          // nothing — otherwise an always-on SessionStart hook adopts tiny's own session as a new one
          // claudeConfigDirEnv removes CLAUDE_CONFIG_DIR when the profile is Claude Code's own
          // default directory: setting it there would point the config lookup at a file that
          // does not exist (see agents/claude.ts)
          env: definedEnv({
            ...process.env,
            ANTHROPIC_API_KEY: undefined,
            ...claudeConfigDirEnv(p.profileDir),
            TINY_SESSION_ID: p.tinySessionId,
          }),
          ...(p.agentSessionId ? { resume: p.agentSessionId } : {}),
          permissionMode: toSdkPermissionMode(p.permissionMode),
          ...(p.model ? { model: p.model } : {}),
          ...(p.effort ? { effort: p.effort as "low" | "medium" | "high" | "xhigh" | "max" } : {}),
          ...(p.permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
          mcpServers,
          allowedTools,
          abortController: abort,
          canUseTool: makeCanUseTool(p),
        },
      });

      // Output tokens per API response, so a response the SDK surfaces more than once is counted once
      const outputByResponse = new Map<string, number>();
      let anonymousResponses = 0;
      for await (const raw of q as AsyncIterable<Record<string, any>>) {
        switch (raw.type) {
          case "system":
            if (raw.subtype === "init") {
              agentSessionId = raw.session_id;
              p.emit({ type: "turn_started", payload: { agentSessionId } });
            }
            break;
          case "assistant": {
            const out = raw.message?.usage?.output_tokens;
            if (typeof out === "number" && Number.isFinite(out) && p.progress) {
              const key = typeof raw.message?.id === "string" ? raw.message.id : `#${anonymousResponses++}`;
              outputByResponse.set(key, Math.max(outputByResponse.get(key) ?? 0, out));
              let outputTokens = 0;
              for (const n of outputByResponse.values()) outputTokens += n;
              p.progress({ outputTokens });
            }
            for (const b of contentBlocks(raw)) {
              // Same rule as the transcript import: a thinking block with a body is the model's progress
              // narration (Fable 5 leaves ordinary thinking empty) and is shown like the terminal shows it
              if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim() !== "") {
                p.emit({ type: "assistant_thinking", payload: { text: b.thinking } });
              }
              if (b.type === "text") p.emit({ type: "assistant_text", payload: { text: b.text } });
              if (b.type === "tool_use") {
                const hint = describeClaudeTool(b.name, b.input);
                p.emit({
                  type: "tool_started",
                  payload: { toolName: b.name, toolUseId: b.id, input: b.input, kind: hint.kind, summary: hint.summary },
                });
              }
            }
            break;
          }
          case "user":
            for (const b of contentBlocks(raw)) {
              if (b.type === "tool_result") {
                p.emit({
                  type: "tool_finished",
                  payload: { toolUseId: b.tool_use_id, isError: b.is_error ?? false, ...toolOutputPayload(b.content) },
                });
              }
            }
            break;
          case "result":
            agentSessionId = raw.session_id ?? agentSessionId;
            costUsd = typeof raw.total_cost_usd === "number" ? raw.total_cost_usd : null;
            resultText = typeof raw.result === "string" ? raw.result : null;
            if (raw.subtype === "success") {
              // Estimated context consumption (used for the app's "context %" display).
              // The top-level usage on result is the **sum of all requests in the turn**, so it is unusable
              // (repeated tool calls add cache_read every time, pushing it to several hundred percent).
              // The last single request in usage.iterations corresponds to the current conversation size
              const u = raw.usage as Record<string, unknown> | undefined;
              const n = (v: unknown) => (typeof v === "number" ? v : 0);
              const iterations = Array.isArray(u?.iterations) ? (u.iterations as Record<string, unknown>[]) : [];
              const last = iterations.length > 0 ? iterations[iterations.length - 1] : u;
              const contextTokens = last
                ? n(last.input_tokens) +
                  n(last.cache_read_input_tokens) +
                  n(last.cache_creation_input_tokens) +
                  n(last.output_tokens)
                : null;
              p.emit({ type: "turn_completed", payload: { costUsd, resultText, contextTokens } });
            } else {
              p.emit({ type: "turn_failed", payload: { subtype: raw.subtype } });
            }
            break;
          default:
            break; // stream_event etc. are dropped in v1
        }
      }
    } finally {
      p.signal.removeEventListener("abort", onAbort);
    }

    if (!agentSessionId) throw new Error("did not receive a session_id from the Agent SDK");
    return { agentSessionId, costUsd, resultText };
  }
}
