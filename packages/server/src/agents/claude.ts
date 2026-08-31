import fs from "node:fs";
import path from "node:path";
import type { AgentDriver } from "./index.js";

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
  homeEnv: (profileDir) => ({ CLAUDE_CONFIG_DIR: profileDir }),
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
