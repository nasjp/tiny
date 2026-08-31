import fs from "node:fs";
import path from "node:path";
import { readAcpChoices } from "../acp-choices.js";
import type { AgentDriver } from "./index.js";

// Gemini CLI (gemini --acp). Measured (HANDOFF "Gemini CLI / Cursor / Droid ACP measurements" 2026-08-30):
// - `initialize` succeeds (loadSession: true / promptCapabilities: { image: true, audio: true } /
//   mcpCapabilities: { http: true, sse: true }). This Mac has no valid auth (`~/.gemini/`
//   has oauth_creds.json, but personal Gemini Code Assist (oauth-personal) is itself
//   deprecated in gemini-cli and errors out), so `session/new` fails. Therefore tool_call /
//   request_permission / cancel / resume are **unmeasured** (we ship only the presumed ask/auto modes)
// - Home: no dedicated env var was found; measured with `HOME=<profileDir>`
//   (`.gemini/{installation_id,...}` was created under the new HOME)
// - login: there is no dedicated top-level login subcommand. Launching `gemini` (interactive
//   mode, no args) presumably runs browser OAuth (not executed). With an API key, env alone suffices

export function geminiLoggedIn(profileDir: string): boolean {
  return fs.existsSync(path.join(profileDir, ".gemini", "oauth_creds.json"));
}

export const geminiDriver: AgentDriver = {
  id: "gemini",
  label: "Gemini CLI",
  bin: "gemini",
  adapter: "acp",
  launch: { command: "gemini", args: ["--acp"] },
  homeEnv: (profileDir) => ({ HOME: profileDir }),
  stripEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"],
  isLoggedIn: geminiLoggedIn,
  login: () => ({ bin: "gemini", args: [] }),
  attach: (s) => ({ bin: "gemini", args: ["--resume", s.agentSessionId] }),
  capabilities: (profileDir) => ({
    // Mirrored from the cached ACP configOptions (see acp-choices.ts); empty until first contact
    models: readAcpChoices(profileDir)?.models ?? [],
    efforts: readAcpChoices(profileDir)?.efforts ?? [],
    permissionModes: [
      { id: "ask", label: "Ask first" },
      { id: "auto", label: "Auto-approve" },
    ],
    // images: measured (initialize.agentCapabilities.promptCapabilities.image: true).
    // usage/questions treated as unimplemented (unmeasured)
    features: { images: true, usage: false, questions: false, attach: true, interrupt: true },
  }),
};
