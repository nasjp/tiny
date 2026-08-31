// Agent "driver definitions". Everything that differs per agent besides the adapter (turn execution) —
// display name, home env var, env vars stripped by the billing guard, login / CLI handoff commands,
// and choices (capabilities) — is confined here. iOS never knows agent names and renders
// only from the label and capabilities the server hands out (the receiving side was built in Phase A).
import { claudeDriver } from "./claude.js";
import { codexDriver } from "./codex.js";
import { cursorDriver } from "./cursor.js";
import { opencodeDriver } from "./opencode.js";

export interface ModelChoice {
  id: string;
  label?: string;
}

export interface PermissionModeChoice {
  id: string;
  label: string;
  description?: string;
}

export interface AgentFeatures {
  images: boolean;
  usage: boolean;
  questions: boolean;
  attach: boolean;
  interrupt: boolean;
}

/**
 * Per-profile (= per-agent) choices. Served as-is by GET /v1/profiles.
 * Convention: the ACP adapter (`AcpAdapter`) treats the permissionModes entry whose id is `auto`
 * as auto-approval (it picks allow_once). When adding an ACP driver, the auto-approval mode's
 * id MUST be `auto`.
 */
export interface AgentCapabilities {
  models: ModelChoice[];
  efforts: string[];
  permissionModes: PermissionModeChoice[];
  features: AgentFeatures;
}

export interface AgentCommand {
  bin: string;
  args: string[];
}

/** Kind of adapter that runs turns. claude uses the Agent SDK, codex uses app-server, everything else ACP */
export type AdapterKind = "claude" | "acp" | "codex";

/** Launch command for an ACP agent (speaks JSON-RPC over stdio) */
export interface AgentLaunch {
  command: string;
  args: string[];
}

export interface AgentDriver {
  id: string;
  label: string;
  /** Executable name used to check presence on PATH */
  bin: string;
  adapter: AdapterKind;
  /** Launch command when adapter is "acp" */
  launch?: AgentLaunch;
  /** Env vars that pass the profile directory as the agent's home */
  homeEnv(profileDir: string): Record<string, string>;
  /** Env vars that MUST be stripped from child processes (leaving them causes pay-per-use API billing instead of the subscription, etc.) */
  stripEnv: string[];
  isLoggedIn(profileDir: string): boolean;
  /** methodId used for ACP `authenticate`. Falls back to `initialize.authMethods[0].id` when absent */
  authMethodId?: string;
  login(): AgentCommand;
  attach(session: { agentSessionId: string }): AgentCommand;
  capabilities(profileDir: string): AgentCapabilities;
  /** Called exactly once by `tiny profiles add`. Config file scaffolding etc. (no-op when absent) */
  prepareProfile?(profileDir: string): void;
}

export const EMPTY_CAPABILITIES: AgentCapabilities = {
  models: [],
  efforts: [],
  permissionModes: [],
  features: { images: false, usage: false, questions: false, attach: false, interrupt: false },
};

// droid / gemini keep their definitions (src/agents/droid.ts, gemini.ts) but stay unregistered (2026-08-30 user decision:
// Droid has no Factory subscription [402], Gemini awaits account/billing decisions). Add them here when needed
const drivers = new Map<string, AgentDriver>([
  [claudeDriver.id, claudeDriver],
  [opencodeDriver.id, opencodeDriver],
  [codexDriver.id, codexDriver],
  [cursorDriver.id, cursorDriver],
]);

/** Register a driver (the built-in startup list lives in this file; tests inject fake drivers through this) */
export function registerDriver(driver: AgentDriver): void {
  drivers.set(driver.id, driver);
}

export function findDriver(id: string): AgentDriver | undefined {
  return drivers.get(id);
}

export function getDriver(id: string): AgentDriver {
  const d = drivers.get(id);
  if (!d) throw new Error(`unknown agent: ${id} (known: ${[...drivers.keys()].join(", ")})`);
  return d;
}

export function listDrivers(): AgentDriver[] {
  return [...drivers.values()];
}

/** Env for child processes: strip stripEnv from the base, then add the home env */
export function agentEnv(
  driver: AgentDriver,
  profileDir: string,
  base: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  for (const k of driver.stripEnv) delete env[k];
  return { ...env, ...driver.homeEnv(profileDir) };
}
