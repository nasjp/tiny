import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentDriver } from "./index.js";

// Cursor CLI (cursor-agent acp). Measured (HANDOFF "Gemini CLI / Cursor / Droid ACP measurements" 2026-08-30):
// - session/new, permission (allow-once/allow-always/reject-once), image, cancel, load are OK.
//   No resume (sessionCapabilities has no resume; loadSession: true. session/load replays the
//   history = AcpAdapter already handles this path)
// - cursor-agent stores its token in the macOS Keychain, and moving `HOME` breaks saving
//   (measured: authenticate { methodId: "cursor_login" } fails with -32603
//   "Failed to save the cursor-access-token credential"). So profile isolation is impossible =
//   all cursor profiles share `~/.cursor` and the Keychain
// - With the real HOME (homeEnv untouched), session/new succeeds directly without authenticate
//   while the token is valid. authMethods is [{ id: "cursor_login" }]

export function cursorLoggedIn(homeDir: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(homeDir, ".cursor", "cli-config.json"), "utf8")) as Record<
      string,
      unknown
    >;
    return parsed !== null && typeof parsed === "object" && parsed.authInfo != null;
  } catch {
    return false;
  }
}

export const cursorDriver: AgentDriver = {
  id: "cursor",
  label: "Cursor",
  bin: "cursor-agent",
  adapter: "acp",
  launch: { command: "cursor-agent", args: ["acp"] },
  // cursor-agent stores its token in the macOS Keychain and moving HOME breaks saving (measured -32603).
  // Profile isolation is impossible = all cursor profiles share ~/.cursor and the Keychain
  homeEnv: () => ({}),
  stripEnv: ["CURSOR_API_KEY"],
  isLoggedIn: (_profileDir) => cursorLoggedIn(os.homedir()),
  login: () => ({ bin: "cursor-agent", args: ["login"] }),
  attach: (s) => ({ bin: "cursor-agent", args: ["--resume", s.agentSessionId] }),
  authMethodId: "cursor_login",
  capabilities: () => ({
    models: [],
    efforts: [],
    permissionModes: [
      { id: "ask", label: "Ask first" },
      { id: "auto", label: "Auto-approve" },
    ],
    // images: measured (initialize.agentCapabilities.promptCapabilities.image: true).
    // usage/questions treated as unimplemented (unmeasured)
    features: { images: true, usage: false, questions: false, attach: true, interrupt: true },
  }),
};
