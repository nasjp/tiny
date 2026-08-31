import type { McpLaunch } from "./mcp-launch.js";
import type { PermissionDecision } from "./permission-broker.js";
import type { ToolHint } from "./tool-kinds.js";
import type { PermissionModeValue } from "./types.js";

export interface TurnEventInput {
  type: string;
  payload: Record<string, unknown>;
}

/** Image attached to a turn (base64). mediaType is limited to the 4 types the Anthropic API accepts */
export interface TurnImage {
  data: string;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
}

export interface RunTurnParams {
  agentSessionId: string | null;
  profileDir: string;
  cwd: string;
  permissionMode: PermissionModeValue;
  /** claude model alias. null follows the default */
  model: string | null;
  /** Reasoning effort (low/medium/high/xhigh/max). null means default */
  effort: string | null;
  prompt: string;
  images?: TurnImage[];
  emit: (ev: TurnEventInput) => void;
  /** hint (kind / summary) feeds the permission banner and push wording. Adapters that can provide it should */
  requestPermission: (toolName: string, input: unknown, hint?: ToolHint) => Promise<PermissionDecision>;
  /** Launch spec of the `tiny mcp-server` that provides send_user_file. null attaches no MCP */
  mcpServer: McpLaunch | null;
  signal: AbortSignal;
}

export interface TurnResult {
  agentSessionId: string;
  costUsd: number | null;
  resultText: string | null;
}

export interface AgentAdapter {
  runTurn(p: RunTurnParams): Promise<TurnResult>;
}
