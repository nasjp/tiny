import fs from "node:fs";
import path from "node:path";
import type { AgentDriver } from "./index.js";

// OpenCode (`opencode acp`, bundled in the binary). Measured (HANDOFF "OpenCode ACP measurements"):
// - Auth lives in $XDG_DATA_HOME/opencode/auth.json (where `opencode auth login` writes)
// - Config is $XDG_CONFIG_HOME/opencode/opencode.json. By default bash/edit trigger no permission
//   requests, so profile creation writes permission: ask (the user may edit it later)
// - The session DB is $XDG_DATA_HOME/opencode/opencode.db → `opencode --session <id>` sees it under the same XDG
// Decision: OpenCode profiles assume API keys / third-party providers (no Claude subscription).
// So API keys like ANTHROPIC_API_KEY are NOT stripped (using them is the premise).

export function opencodeXdg(profileDir: string): { data: string; config: string; cache: string; state: string } {
  const base = path.join(profileDir, "xdg");
  return { data: path.join(base, "data"), config: path.join(base, "config"), cache: path.join(base, "cache"), state: path.join(base, "state") };
}

export function opencodeAuthPath(profileDir: string): string {
  return path.join(opencodeXdg(profileDir).data, "opencode", "auth.json");
}

export function opencodeConfigPath(profileDir: string): string {
  return path.join(opencodeXdg(profileDir).config, "opencode", "opencode.json");
}

/** Whether auth.json has at least one provider entry (never inspects the keys inside) */
export function opencodeLoggedIn(profileDir: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(opencodeAuthPath(profileDir), "utf8")) as Record<string, unknown>;
    return parsed !== null && typeof parsed === "object" && Object.keys(parsed).length > 0;
  } catch {
    return false;
  }
}

const DEFAULT_CONFIG = {
  $schema: "https://opencode.ai/config.json",
  // Makes tiny's "Ask first" hold (by default things run with no permission request).
  // Don't write model: opencode picks a default from the logged-in providers. Add by hand if needed
  permission: { bash: "ask", edit: "ask", webfetch: "ask" },
};

export const opencodeDriver: AgentDriver = {
  id: "opencode",
  label: "OpenCode",
  bin: "opencode",
  adapter: "acp",
  launch: { command: "opencode", args: ["acp"] },
  homeEnv: (profileDir) => {
    const x = opencodeXdg(profileDir);
    return { XDG_DATA_HOME: x.data, XDG_CONFIG_HOME: x.config, XDG_CACHE_HOME: x.cache, XDG_STATE_HOME: x.state };
  },
  stripEnv: [],
  isLoggedIn: opencodeLoggedIn,
  login: () => ({ bin: "opencode", args: ["auth", "login"] }),
  attach: (s) => ({ bin: "opencode", args: ["--session", s.agentSessionId] }),
  capabilities: () => ({
    // Models / efforts: ACP configOptions is the source of truth (100+ entries, provider-dependent). Mirroring is future work. Empty = the app shows no choices
    models: [],
    efforts: [],
    permissionModes: [
      { id: "ask", label: "Ask first" },
      { id: "auto", label: "Auto-approve" },
    ],
    features: { images: true, usage: false, questions: false, attach: true, interrupt: true },
  }),
  prepareProfile: (profileDir) => {
    const cfg = opencodeConfigPath(profileDir);
    if (fs.existsSync(cfg)) return;
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
  },
};
