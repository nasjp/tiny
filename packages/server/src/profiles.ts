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

/** Metadata directory of a profile: always under profilesDir, even when configDir points elsewhere */
function profileMetaDir(profilesDir: string, name: string): string {
  if (!NAME_RE.test(name)) throw new Error(`invalid profile name: ${name}`);
  const dir = path.join(profilesDir, name);
  if (!fs.existsSync(dir)) throw new Error(`profile not found: ${name}`);
  return dir;
}

/** Merge-write one key into tiny-profile.json, keeping whatever else is there */
function patchProfileMeta(metaDir: string, patch: Record<string, unknown>): void {
  const file = path.join(metaDir, PROFILE_META);
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    // a profile without metadata is a legacy claude profile; start fresh
  }
  fs.writeFileSync(file, JSON.stringify({ ...meta, ...patch }, null, 2) + "\n");
}

/**
 * Whether `tiny live` is on for a profile whose agent has no hooks (codex / opencode): tinyd then
 * scans the agent's own storage and adopts sessions the person starts in the terminal. Claude
 * profiles keep their hook-based flag in the agent's settings.json (claude-hooks.ts), not here.
 */
export function readProfileLive(profilesDir: string, name: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(profileMetaDir(profilesDir, name), PROFILE_META), "utf8");
    return (JSON.parse(raw) as { live?: unknown }).live === true;
  } catch {
    return false;
  }
}

export function setProfileLive(profilesDir: string, name: string, on: boolean): void {
  patchProfileMeta(profileMetaDir(profilesDir, name), { live: on });
}

/** External CLAUDE_CONFIG_DIR of a profile (tiny-profile.json "configDir"). null when the profile owns its directory */
export function readProfileConfigDir(dir: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(dir, PROFILE_META), "utf8");
    const parsed = JSON.parse(raw) as { configDir?: unknown };
    return typeof parsed.configDir === "string" && parsed.configDir !== "" ? parsed.configDir : null;
  } catch {
    return null;
  }
}

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

/** Driver for a profile (throws for an unregistered agent). tiny-profile.json lives in the metadata dir */
export function profileDriver(profilesDir: string, name: string): AgentDriver {
  return getDriver(readProfileAgent(profileMetaDir(profilesDir, name)));
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
  const metaDir = path.join(profilesDir, name);
  const agent = readProfileAgent(metaDir);
  // The agent's real CLAUDE_CONFIG_DIR. A handoff profile points at an external one (e.g. ~/.claude)
  const dir = readProfileConfigDir(metaDir) ?? metaDir;
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

export function addProfile(profilesDir: string, name: string, agent = "claude", configDir?: string): ProfileInfo {
  if (!NAME_RE.test(name)) throw new Error(`invalid profile name: ${name}`);
  const driver = getDriver(agent); // throws if unregistered
  const metaDir = path.join(profilesDir, name);
  fs.mkdirSync(metaDir, { recursive: true });
  fs.writeFileSync(
    path.join(metaDir, PROFILE_META),
    JSON.stringify({ agent, ...(configDir ? { configDir } : {}) }, null, 2) + "\n",
  );
  // Never scaffold into someone else's CLAUDE_CONFIG_DIR
  if (!configDir) driver.prepareProfile?.(metaDir);
  return info(profilesDir, name);
}

/**
 * Renames the profile directory. The Keychain item (macOS token) and the DB's
 * sessions.profile must be moved separately — the CLI's `profiles rename` ties them together.
 * Only the metadata directory moves: a configDir profile points at a directory tiny does not own.
 */
export function renameProfile(profilesDir: string, from: string, to: string): ProfileInfo {
  const src = profileMetaDir(profilesDir, from); // metadata only — never the external configDir
  if (!NAME_RE.test(to)) throw new Error(`invalid profile name: ${to}`);
  if (from === to) throw new Error(`profile is already named ${to}`);
  const dst = path.join(profilesDir, to);
  if (fs.existsSync(dst)) throw new Error(`profile already exists: ${to}`);
  fs.renameSync(src, dst);
  return info(profilesDir, to);
}

export function profileDir(profilesDir: string, name: string): string {
  if (!NAME_RE.test(name)) throw new Error(`invalid profile name: ${name}`);
  const metaDir = path.join(profilesDir, name);
  if (!fs.existsSync(metaDir)) throw new Error(`profile not found: ${name}`);
  const external = readProfileConfigDir(metaDir);
  if (external === null) return metaDir;
  if (!fs.existsSync(external)) throw new Error(`profile config dir not found: ${external}`);
  return external;
}
