import fs from "node:fs";
import path from "node:path";
import { readAcpChoices } from "../acp-choices.js";
import { OPENCODE_PEER_ENV, opencodePermissionView, opencodeServerPermissions, opencodeServerReply } from "../opencode-peer.js";
import type { AgentDriver } from "./index.js";

// OpenCode (`opencode acp`, bundled in the binary). Measured (HANDOFF "OpenCode ACP measurements"):
// - Auth lives in $XDG_DATA_HOME/opencode/auth.json (where `opencode auth login` writes)
// - Config is $XDG_CONFIG_HOME/opencode/opencode.json. By default bash/edit trigger no permission
//   requests, so profile creation writes permission: ask (the user may edit it later)
// - The session DB is $XDG_DATA_HOME/opencode/opencode.db → `opencode --session <id>` sees it under the same XDG
// Decision: OpenCode profiles assume API keys / third-party providers (no Claude subscription).
// So API keys like ANTHROPIC_API_KEY are NOT stripped (using them is the premise).

/**
 * The XDG root a profile wraps (tiny-profile.json "xdgRoot"), or null for tiny's own tree.
 * Set by `tiny profiles add <name> --agent opencode --config-dir ~`: the opencode the person runs
 * in the terminal (XDG_* unset) keeps everything under $HOME's default XDG dirs, spread over four
 * directories, so the profile cannot simply BE that home the way a claude / codex profile can.
 * The profile dir stays tiny's (acp-choices.json etc. land there) and only the XDG tree points out
 */
export function opencodeXdgRoot(profileDir: string): string | null {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(profileDir, "tiny-profile.json"), "utf8")) as { xdgRoot?: unknown };
    return typeof meta.xdgRoot === "string" && meta.xdgRoot !== "" ? meta.xdgRoot : null;
  } catch {
    return null;
  }
}

export function opencodeXdg(profileDir: string): { data: string; config: string; cache: string; state: string } {
  const root = opencodeXdgRoot(profileDir);
  if (root !== null) {
    // The XDG Base Directory defaults, which is where a terminal opencode with no XDG_* set looks
    return {
      data: path.join(root, ".local", "share"),
      config: path.join(root, ".config"),
      cache: path.join(root, ".cache"),
      state: path.join(root, ".local", "state"),
    };
  }
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

// Makes tiny's "Ask first" hold (by default things run with no permission request)
const ASK_PERMISSIONS = { bash: "ask", edit: "ask", webfetch: "ask" };

const DEFAULT_CONFIG = {
  $schema: "https://opencode.ai/config.json",
  // Don't write model: opencode picks a default from the logged-in providers. Add by hand if needed
  permission: ASK_PERMISSIONS,
};

export const opencodeDriver: AgentDriver = {
  id: "opencode",
  label: "OpenCode",
  bin: "opencode",
  adapter: "acp",
  launch: { command: "opencode", args: ["acp"] },
  // `opencode acp` serves the HTTP API on loopback anyway (4096, else a random port); pinning the
  // port is what lets the adapter reach it for the subagent prompts ACP drops
  acpSideChannel: {
    launchArgs: (port) => ["--port", String(port)],
    pending: async (port, cwd, acpSessionId) =>
      (await opencodeServerPermissions(port, cwd))
        .filter((r) => r.sessionID !== acpSessionId)
        .map((r) => ({ id: r.id, ...opencodePermissionView({ ...r, root: acpSessionId }) })),
    reply: (port, cwd, id, allow) => opencodeServerReply(port, cwd, id, allow ? "once" : "reject"),
  },
  // tiny's own plugin (installed for `tiny live on`) loads in every opencode on that config,
  // tiny's children included; those are tiny already and must not offer themselves as a terminal
  turnEnv: { [OPENCODE_PEER_ENV]: "off" },
  homeEnv: (profileDir) => {
    const x = opencodeXdg(profileDir);
    const env: Record<string, string> = { XDG_DATA_HOME: x.data, XDG_CONFIG_HOME: x.config, XDG_CACHE_HOME: x.cache, XDG_STATE_HOME: x.state };
    // A wrapped terminal opencode has the person's own opencode.json, which tiny never edits (and
    // which usually lets everything run unasked). Measured on 1.18.35: OPENCODE_CONFIG_CONTENT is
    // merged over it, so tiny's own launches still ask first
    if (opencodeXdgRoot(profileDir) !== null) env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ permission: ASK_PERMISSIONS });
    return env;
  },
  stripEnv: [],
  isLoggedIn: opencodeLoggedIn,
  login: () => ({ bin: "opencode", args: ["auth", "login"] }),
  attach: (s) => ({ bin: "opencode", args: ["--session", s.agentSessionId] }),
  capabilities: (profileDir) => ({
    // Models / efforts: mirrored from the ACP configOptions the agent last reported (cached at
    // <profileDir>/acp-choices.json by the adapter on every session/new|resume and seeded by
    // `tiny profiles login`). Empty until first contact = the app shows no choices
    models: readAcpChoices(profileDir)?.models ?? [],
    efforts: readAcpChoices(profileDir)?.efforts ?? [],
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
