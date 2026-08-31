import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { McpLaunch } from "../mcp-launch.js";
import type { AgentDriver } from "./index.js";

// Codex (`codex app-server`, JSON-RPC/stdio). CODEX_HOME = the profile dir
// (holds auth.json / config.toml / sessions/; codex itself also auto-creates sqlite etc.).
// Decision: login is left to `codex login` (the official flow); tiny never reads or touches auth.json.
// Drop OPENAI_API_KEY / CODEX_API_KEY (leaving them bills API pay-as-you-go instead of ChatGPT auth).

export function codexLoggedIn(profileDir: string): boolean {
  return fs.existsSync(path.join(profileDir, "auth.json"));
}

export function codexConfigPath(profileDir: string): string {
  return path.join(profileDir, "config.toml");
}

const MCP_BEGIN = "# >>> tiny mcp (managed by tinyd; rewritten every turn) >>>";
const MCP_END = "# <<< tiny mcp <<<";

/** TOML basic string (escaping `\` and `"` is sufficient) */
function toml(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function renderRegion(mcp: McpLaunch): string {
  const lines = [
    MCP_BEGIN,
    "[mcp_servers.tiny]",
    `command = ${toml(mcp.command)}`,
    `args = [${mcp.args.map(toml).join(", ")}]`,
    "[mcp_servers.tiny.env]",
    ...Object.entries(mcp.env).map(([k, v]) => `${k} = ${toml(v)}`),
    MCP_END,
  ];
  return lines.join("\n") + "\n";
}

/**
 * Registers the `tiny mcp-server` that provides `send_user_file` with Codex.
 * Measured: passing MCP per thread via the `thread/start` config is silently ignored;
 * only `[mcp_servers.tiny]` in `$CODEX_HOME/config.toml` takes effect. So every turn we
 * rewrite the region delimited by marker lines (user settings outside the region are always preserved).
 *
 * Note: on this path the CLI token (TINY_TOKEN) lands in the profile's config.toml.
 * It is a secret, so write the file with mode 0600.
 * Note 2: the marker region ends with a table (`[mcp_servers.tiny.env]`), so a file that puts
 * bare keys with no table header right after the region will have those lines absorbed into env.
 * (The region is appended at the end of the file by default, so this normally never happens)
 */
export function writeTinyMcpServer(profileDir: string, mcp: McpLaunch | null): void {
  const file = codexConfigPath(profileDir);
  let existing = "";
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch {
    if (!mcp) return; // nothing to delete or write (don't create the file in tests or with MCP disabled)
  }
  const region = mcp ? renderRegion(mcp) : "";
  const begin = existing.indexOf(MCP_BEGIN);
  const end = existing.indexOf(MCP_END);
  let next: string;
  if (begin !== -1 && end !== -1 && end > begin) {
    let after = end + MCP_END.length;
    if (existing[after] === "\n") after += 1;
    next = existing.slice(0, begin) + region + existing.slice(after);
  } else if (existing === "") {
    next = region;
  } else {
    next = (existing.endsWith("\n") ? existing : existing + "\n") + region;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // codex itself may create config.toml first (default 0644), and writeFileSync's { mode }
  // only applies at creation — it never changes an existing file's mode. Write a temp file
  // with 0600, then rename (atomic replace), and chmod as well to be safe.
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, next, { mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Even if cleanup fails, throw the original failure
    }
    throw err;
  }
}

export const codexDriver: AgentDriver = {
  id: "codex",
  label: "Codex",
  bin: "codex",
  adapter: "codex",
  launch: { command: "codex", args: ["app-server"] },
  homeEnv: (profileDir) => ({ CODEX_HOME: profileDir }),
  stripEnv: ["OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY"],
  isLoggedIn: codexLoggedIn,
  login: () => ({ bin: "codex", args: ["login"] }),
  // Measured: `codex resume <threadId>` can take over under the same CODEX_HOME
  // (`--skip-git-repo-check` does not exist in 0.149.1)
  attach: (s) => ({ bin: "codex", args: ["resume", s.agentSessionId] }),
  capabilities: () => ({
    // Leave the model to the config.toml default (mirroring model/list is future work)
    models: [],
    efforts: ["low", "medium", "high", "xhigh"],
    permissionModes: [
      { id: "ask", label: "Ask first" },
      { id: "auto", label: "Auto (sandboxed)" },
      { id: "bypass", label: "Bypass (full access)" },
    ],
    // questions: measured, `item/tool/requestUserInput` is unusable in Default mode
    // ("request_user_input is unavailable in Default mode"). The mapping is implemented but shipped as false
    features: { images: true, usage: true, questions: false, attach: true, interrupt: true },
  }),
};
