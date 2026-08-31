import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentDriver } from "./index.js";

/** Claude Code's default data directory (the one it uses when CLAUDE_CONFIG_DIR is unset) */
export function defaultClaudeConfigDir(): string {
  return path.join(os.homedir(), ".claude");
}

/** realpath when the path exists (symlinked homes); plain resolve otherwise (trailing slash, "..") */
function canonicalDir(dir: string): string {
  const abs = path.resolve(dir);
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs; // not created yet — the textual form is the best we have
  }
}

/** Whether `dir` is the directory Claude Code uses on its own */
export function isDefaultClaudeConfigDir(dir: string): boolean {
  return canonicalDir(dir) === canonicalDir(defaultClaudeConfigDir());
}

/**
 * Env that points Claude Code at `dir`. `undefined` means the variable MUST be removed, not set
 * to an empty string: Claude Code locates its config file asymmetrically — unset it reads
 * ~/.claude.json (home root), set to $X it reads $X/.claude.json. So naming the default data
 * directory explicitly is not the no-op it looks like; it moves the lookup to
 * ~/.claude/.claude.json, which a normal installation does not have, and every turn dies with
 * "Claude configuration file not found". A `tiny handoff` profile points at exactly that directory.
 */
export function claudeConfigDirEnv(dir: string): { CLAUDE_CONFIG_DIR: string | undefined } {
  return { CLAUDE_CONFIG_DIR: isDefaultClaudeConfigDir(dir) ? undefined : dir };
}

// Login detection:
// - Linux etc.: the token is written to $CLAUDE_CONFIG_DIR/.credentials.json
// - macOS: the token goes into the Keychain (Claude Code-credentials-<hash>) and
//   account info is written to oauthAccount in .claude.json instead
export function readClaudeOauthAccount(dir: string): { emailAddress?: unknown } | null {
  try {
    const raw = fs.readFileSync(path.join(dir, ".claude.json"), "utf8");
    const parsed = JSON.parse(raw) as { oauthAccount?: { emailAddress?: unknown } | null };
    return parsed.oauthAccount ?? null;
  } catch {
    return null;
  }
}

/** Whether logged in (never inspects token contents; never touches the Keychain) */
export function claudeLoggedIn(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".credentials.json")) || readClaudeOauthAccount(dir) != null;
}

// Models are pinned to full IDs (aliases would hide what actually ran). Add one line here when a new model ships
const CLAUDE_MODELS = [
  { id: "claude-fable-5", label: "Claude Fable 5" },
  { id: "claude-opus-5", label: "Claude Opus 5" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

export const claudeDriver: AgentDriver = {
  id: "claude",
  label: "Claude",
  bin: "claude",
  adapter: "claude",
  homeEnv: (profileDir) => claudeConfigDirEnv(profileDir),
  // Leaving it bills API pay-as-you-go instead of the subscription
  stripEnv: ["ANTHROPIC_API_KEY"],
  isLoggedIn: claudeLoggedIn,
  login: () => ({ bin: "claude", args: ["/login"] }),
  attach: (s) => ({ bin: "claude", args: ["--resume", s.agentSessionId] }),
  capabilities: () => ({
    models: CLAUDE_MODELS,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    permissionModes: [
      { id: "default", label: "Ask first" },
      { id: "acceptEdits", label: "Auto-accept edits" },
      { id: "bypassPermissions", label: "Bypass permissions" },
    ],
    features: { images: true, usage: true, questions: true, attach: true, interrupt: true },
  }),
};
