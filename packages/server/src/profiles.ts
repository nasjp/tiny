import fs from "node:fs";
import path from "node:path";
import { EMPTY_CAPABILITIES, findDriver, getDriver, type AgentCapabilities, type AgentDriver } from "./agents/index.js";
import { claudeLoggedIn, readClaudeOauthAccount } from "./agents/claude.js";

export interface ProfileInfo {
  name: string;
  dir: string;
  loggedIn: boolean;
  /** id of the agent this profile runs (from tiny-profile.json; claude if absent) */
  agent: string;
  /** display name (driver label; the raw id for an unknown agent) */
  label: string;
  /** available options; empty for an unknown agent */
  capabilities: AgentCapabilities;
  /** model from settings.json; null if unset (= CLI auto-selects) */
  defaultModel: string | null;
  /** effort from settings.json; null if unset (= CLI default) */
  defaultEffort: string | null;
  /** email address of the logged-in account; null if logged out/unknown */
  email: string | null;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const PROFILE_META = "tiny-profile.json";

/** Agent kind of a profile. Existing profiles with a missing/broken tiny-profile.json are claude */
export function readProfileAgent(dir: string): string {
  try {
    const raw = fs.readFileSync(path.join(dir, PROFILE_META), "utf8");
    const parsed = JSON.parse(raw) as { agent?: unknown };
    return typeof parsed.agent === "string" && parsed.agent !== "" ? parsed.agent : "claude";
  } catch {
    return "claude";
  }
}

/** Driver for a profile (throws for an unregistered agent) */
export function profileDriver(profilesDir: string, name: string): AgentDriver {
  return getDriver(readProfileAgent(profileDir(profilesDir, name)));
}

// What "default (follow the CLI's settings)" actually means = model/effort in the profile's
// settings.json. If absent, the CLI's built-in auto-selection applies
function readDefaults(dir: string): { defaultModel: string | null; defaultEffort: string | null } {
  try {
    const raw = fs.readFileSync(path.join(dir, "settings.json"), "utf8");
    const parsed = JSON.parse(raw) as { model?: unknown; effort?: unknown };
    return {
      defaultModel: typeof parsed.model === "string" ? parsed.model : null,
      defaultEffort: typeof parsed.effort === "string" ? parsed.effort : null,
    };
  } catch {
    return { defaultModel: null, defaultEffort: null };
  }
}

/** Whether logged in (Claude; never inspects token contents and never touches the Keychain) */
export function isProfileLoggedIn(dir: string): boolean {
  return claudeLoggedIn(dir);
}

function info(profilesDir: string, name: string): ProfileInfo {
  const dir = path.join(profilesDir, name);
  const agent = readProfileAgent(dir);
  const driver = findDriver(agent);
  const oauth = agent === "claude" ? readClaudeOauthAccount(dir) : null;
  const email = typeof oauth?.emailAddress === "string" ? oauth.emailAddress : null;
  return {
    name,
    dir,
    // Unknown agents (profiles created by a newer tinyd) are listed but treated as unusable
    loggedIn: driver ? driver.isLoggedIn(dir) : false,
    agent,
    label: driver?.label ?? agent,
    capabilities: driver?.capabilities(dir) ?? EMPTY_CAPABILITIES,
    email,
    ...readDefaults(dir),
  };
}

export function listProfiles(profilesDir: string): ProfileInfo[] {
  if (!fs.existsSync(profilesDir)) return [];
  return fs
    .readdirSync(profilesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => info(profilesDir, e.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function addProfile(profilesDir: string, name: string, agent = "claude"): ProfileInfo {
  if (!NAME_RE.test(name)) throw new Error(`invalid profile name: ${name}`);
  const driver = getDriver(agent); // throws if unregistered
  const dir = path.join(profilesDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, PROFILE_META), JSON.stringify({ agent }, null, 2) + "\n");
  driver.prepareProfile?.(dir);
  return info(profilesDir, name);
}

/**
 * Renames the profile directory. The Keychain item (macOS token) and the DB's
 * sessions.profile must be moved separately — the CLI's `profiles rename` ties them together.
 */
export function renameProfile(profilesDir: string, from: string, to: string): ProfileInfo {
  const src = profileDir(profilesDir, from); // doubles as name validation and existence check
  if (!NAME_RE.test(to)) throw new Error(`invalid profile name: ${to}`);
  if (from === to) throw new Error(`profile is already named ${to}`);
  const dst = path.join(profilesDir, to);
  if (fs.existsSync(dst)) throw new Error(`profile already exists: ${to}`);
  fs.renameSync(src, dst);
  return info(profilesDir, to);
}

export function profileDir(profilesDir: string, name: string): string {
  if (!NAME_RE.test(name)) throw new Error(`invalid profile name: ${name}`);
  const dir = path.join(profilesDir, name);
  if (!fs.existsSync(dir)) throw new Error(`profile not found: ${name}`);
  return dir;
}
