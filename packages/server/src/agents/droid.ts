import fs from "node:fs";
import path from "node:path";
import { readAcpChoices } from "../acp-choices.js";
import type { AgentDriver } from "./index.js";

// Factory Droid (droid exec --output-format acp). Measured (HANDOFF "Gemini CLI / Cursor / Droid
// ACP measurements", updated 2026-08-30): without auth, `session/new` fails with -32000
// "Authentication required", but initialize.authMethods returns
// [{ id: "device-pairing" }, { id: "factory-api-key" }], and
// authenticate { methodId: "device-pairing" } → retrying session/new succeeds (AcpAdapter
// handles authenticate-and-retry). After session/new, all OK: configOptions (autonomy_level /
// model / reasoning_effort), modes (normal / spec / auto-low / auto-medium / auto-high),
// cancel 383ms, resume/load OK. **session/prompt is unsmoked: 402 "No active subscription"
// (requires a Factory contract)**
// - Home: found `FACTORY_HOME_OVERRIDE` via strings and measured (`<dir>/.factory/{sessions,...}`
//   was created and `droid doctor --auth --json` showed factoryDir at the new home)
// - login: no dedicated top-level login subcommand (absent from `droid --help`). Remediation is
//   "launch droid and complete the login flow" = defer to the interactive TUI (`{ bin: "droid", args: [] }`)

export function droidLoggedIn(profileDir: string): boolean {
  return fs.existsSync(path.join(profileDir, ".factory", "auth.json"));
}

export const droidDriver: AgentDriver = {
  id: "droid",
  label: "Droid",
  bin: "droid",
  adapter: "acp",
  launch: { command: "droid", args: ["exec", "--output-format", "acp"] },
  homeEnv: (profileDir) => ({ FACTORY_HOME_OVERRIDE: profileDir }),
  stripEnv: ["FACTORY_API_KEY"],
  isLoggedIn: droidLoggedIn,
  login: () => ({ bin: "droid", args: [] }),
  attach: (s) => ({ bin: "droid", args: ["--resume", s.agentSessionId] }),
  authMethodId: "device-pairing",
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
