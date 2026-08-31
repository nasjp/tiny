import { tinyLaunch, type LaunchCommand } from "./entry.js";

/** Command an adapter launches as the MCP server (env differs per session) */
export interface McpLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Per-session, per-turn launch spec for `tiny mcp-server`. token is a turn-scoped session token (never the CLI token).
 * The launch command is "the same tiny that is currently running" (via tsx for src, node directly for dist; entry.ts decides)
 */
export function makeMcpLaunch(opts: { serverUrl: () => string; launch?: LaunchCommand }): (sessionId: string, token: string) => McpLaunch {
  const base = opts.launch ?? tinyLaunch();
  return (sessionId, token) => ({
    command: base.command,
    args: [...base.args, "mcp-server"],
    env: { TINY_SERVER_URL: opts.serverUrl(), TINY_TOKEN: token, TINY_SESSION_ID: sessionId },
  });
}
