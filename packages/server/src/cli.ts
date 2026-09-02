#!/usr/bin/env node
import { Command } from "commander";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import qrcode from "qrcode-terminal";
import { tinyPaths } from "./config.js";
import { summarizePeerInboxes } from "./claude-peer.js";
import { installDaemon, readInstalledDaemon, uninstallDaemon } from "./daemon.js";
import { collectDoctor, formatDoctorReport, type AlwaysHandoffTarget } from "./doctor.js";
import { openDb } from "./db.js";
import { tinyEntry, tinyLaunch } from "./entry.js";
import { buildHookCommand, readLiveMode, setLiveMode } from "./claude-hooks.js";
import { fetchAcpChoices } from "./acp-adapter.js";
import { detectTailscaleIp } from "./tailscale.js";
import { findOnPath } from "./which.js";
import { migrateClaudeCredential, type KeychainMigration } from "./keychain.js";
import { addProfile, listProfiles, profileDir, profileDriver, readProfileLive, renameProfile, setProfileLive, type ProfileInfo } from "./profiles.js";
import { agentEnv, getDriver, listDrivers } from "./agents/index.js";
import { defaultClaudeConfigDir } from "./agents/claude.js";
import { runSetup } from "./setup.js";
import { TINY_VERSION } from "./version.js";
import { createStores } from "./stores.js";
import { loadSettings, saveSettings } from "./settings.js";
import type { SessionRecord } from "./types.js";

export interface AttachCommand {
  bin: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
}

export function buildAttachCommand(session: SessionRecord, profilesDir: string): AttachCommand {
  if (!session.agentSessionId) {
    throw new Error("This session has no turns yet, so there is nothing to resume (run one turn from the app or CLI first)");
  }
  // Build the CLI handoff command and env from the driver of the agent recorded on the session
  const driver = getDriver(session.agent);
  const cmd = driver.attach({ agentSessionId: session.agentSessionId });
  return {
    bin: cmd.bin,
    args: cmd.args,
    cwd: session.cwd,
    env: agentEnv(driver, path.join(profilesDir, session.profile)),
  };
}

export interface HandoffInput {
  /** Session id of the Claude Code process that invoked us. null when not run inside one */
  agentSessionId: string | null;
  /** CLAUDE_CONFIG_DIR the caller is running under */
  configDir: string;
}

/**
 * Where `tiny handoff` gets its inputs. CLAUDE_CODE_SESSION_ID is an official variable:
 * the changelog documents it as matching the session_id passed to hooks.
 */
export function resolveHandoffInput(env: Record<string, string | undefined>): HandoffInput {
  const sid = env.CLAUDE_CODE_SESSION_ID;
  const dir = env.CLAUDE_CONFIG_DIR;
  return {
    agentSessionId: typeof sid === "string" && sid !== "" ? sid : null,
    // An empty env var means "not set" here, same as for the session id above
    configDir: typeof dir === "string" && dir !== "" ? dir : defaultClaudeConfigDir(),
  };
}

/**
 * What `tiny doctor` reports for always-handoff: every place `tiny live` can be set, starting with
 * the config dir the caller's own shell uses. A profile pointing at that same directory is named
 * once (as that profile), and profiles of other agents are left out — the hooks are Claude Code's.
 * A profile whose mode cannot be read (its external config dir is gone) is skipped rather than
 * taking the report down with it.
 */
export function alwaysHandoffTargets(
  profiles: ProfileInfo[],
  selfDir: string,
  readMode: (dir: string) => boolean = readLiveMode,
  readScanFlag?: (name: string) => boolean,
): AlwaysHandoffTarget[] {
  const claude = profiles.filter((p) => p.agent === "claude");
  const mode = (dir: string): boolean | null => {
    try {
      return readMode(dir);
    } catch {
      return null;
    }
  };
  const self = claude.find((p) => p.dir === selfDir);
  const selfOn = mode(selfDir);
  const targets: AlwaysHandoffTarget[] = selfOn === null
    ? []
    : [{ name: `${self ? self.name : selfDir} (this shell)`, on: selfOn }];
  for (const p of claude) {
    if (p.dir === selfDir) continue;
    const on = mode(p.dir);
    if (on !== null) targets.push({ name: p.name, on });
  }
  // Hookless agents (codex / opencode): the flag lives in tiny-profile.json and means "tinyd scans
  // the agent's own storage" rather than "a hook fires"
  for (const p of profiles) {
    if (p.agent !== "codex" && p.agent !== "opencode") continue;
    try {
      targets.push({ name: `${p.name} (scan)`, on: readScanFlag?.(p.name) ?? false });
    } catch {
      // an unreadable profile must not take the report down
    }
  }
  return targets;
}

/**
 * Which CLAUDE_CONFIG_DIR `tiny live` reads or writes the hooks in. The mode lives in exactly one
 * settings.json, so this must never be a guess: `--profile` names a tiny profile (following it to
 * an external config dir when the profile points at one), `--config-dir` is taken as given, and
 * with neither it is the shell's own — the same directory the caller's `claude` would use.
 */
export function resolveLiveConfigDir(
  opts: { profile?: string; configDir?: string },
  profilesDir: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (opts.profile !== undefined && opts.configDir !== undefined) {
    throw new Error("pass either --profile or --config-dir, not both");
  }
  if (opts.profile !== undefined) return profileDir(profilesDir, opts.profile);
  if (opts.configDir !== undefined) return opts.configDir;
  const dir = env.CLAUDE_CONFIG_DIR;
  return typeof dir === "string" && dir !== "" ? dir : defaultClaudeConfigDir();
}

/**
 * Whether we are running inside an agent tiny itself spawned. TINY_SESSION_ID is only ever set in
 * the environment tiny gives those agents, and there is nothing there to hand off: the session is
 * already tiny's. The Agent SDK reads every settings source, so with `tiny live on` the
 * SessionStart hook does fire in there, once per turn.
 */
export function isInsideTinyAgent(env: Record<string, string | undefined>): boolean {
  const id = env.TINY_SESSION_ID;
  return typeof id === "string" && id !== "";
}

/**
 * Pull session_id out of the JSON object Claude Code writes to a hook's stdin.
 * A fallback for CLAUDE_CODE_SESSION_ID: the whole always-on mode rests on that one variable.
 */
export function parseHookSessionId(raw: string): string | null {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null; // not a hook invocation, or a truncated payload
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const id = (payload as { session_id?: unknown }).session_id;
  return typeof id === "string" && id !== "" ? id : null;
}

export interface QuestionHook {
  agentSessionId: string;
  toolUseId: string;
  input: Record<string, unknown>;
}

/**
 * The PreToolUse payload for an AskUserQuestion, as Claude Code writes it to a hook's stdin
 * (2.1.252: session_id / tool_name / tool_use_id / tool_input). Anything else is not ours to report.
 */
export function parseQuestionHook(raw: string): QuestionHook | null {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  const str = (k: string): string | null => (typeof p[k] === "string" && p[k] !== "" ? (p[k] as string) : null);
  const agentSessionId = str("session_id");
  const toolUseId = str("tool_use_id");
  const input = p.tool_input;
  if (str("tool_name") !== "AskUserQuestion" || !agentSessionId || !toolUseId) return null;
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  return { agentSessionId, toolUseId, input: input as Record<string, unknown> };
}

/**
 * Read stdin, giving up after `timeoutMs`. A hook payload arrives immediately; a human running
 * `tiny handoff` in a terminal must never be left waiting on input they do not know to give.
 */
async function readStdinBriefly(timeoutMs = 300): Promise<string> {
  if (process.stdin.isTTY) return "";
  return await new Promise<string>((resolve) => {
    let buf = "";
    const finish = (): void => {
      clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.off("end", finish);
      process.stdin.off("error", finish);
      process.stdin.pause();
      resolve(buf);
    };
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString("utf8");
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.on("data", onData).on("end", finish).on("error", finish);
  });
}

/** Find (or create) the profile that points at this CLAUDE_CONFIG_DIR. Returns its name */
export function ensureHandoffProfile(profilesDir: string, configDir: string, name = "local"): string {
  for (const p of listProfiles(profilesDir)) {
    if (p.dir === configDir) return p.name;
  }
  let candidate = name;
  let n = 1;
  while (fs.existsSync(path.join(profilesDir, candidate))) {
    n += 1;
    candidate = `${name}-${n}`;
  }
  addProfile(profilesDir, candidate, "claude", configDir);
  return candidate;
}

export function resolveSessionId(sessions: SessionRecord[], prefix: string): string {
  const hits = sessions.filter((s) => s.id.startsWith(prefix));
  if (hits.length === 0) throw new Error(`session not found: ${prefix}`);
  if (hits.length > 1) throw new Error(`ambiguous id (${hits.length} matches): ${prefix}`);
  return hits[0]!.id;
}

export function formatProfileRow(prof: ProfileInfo): string {
  const status = prof.loggedIn ? "logged in" : "not logged in";
  return `${prof.name.padEnd(12)} ${status.padEnd(14)} ${prof.email ?? "-"}`;
}

export interface RenameProfileDeps {
  profilesDir: string;
  /** Names of profiles that have a running turn. Watchdog so we never move a profile out from under a running turn */
  runningProfiles: () => string[];
  renameSessions: (from: string, to: string) => number;
  migrateCredential: (fromDir: string, toDir: string) => KeychainMigration;
}

export interface RenameProfileResult {
  dir: string;
  sessionsUpdated: number;
  keychain: KeychainMigration;
}

/**
 * Rename the directory, the Keychain token, and sessions.profile in the DB together.
 * Missing any one of them breaks the profile (it shows as logged out / attach fails),
 * so on a mid-way failure the directory is moved back as if nothing happened.
 */
export function runProfileRename(deps: RenameProfileDeps, from: string, to: string): RenameProfileResult {
  const running = deps.runningProfiles();
  if (running.includes(from)) {
    throw new Error(`profile ${from} has a running turn; wait for it to finish or interrupt it first`);
  }
  const fromDir = path.join(deps.profilesDir, from);
  const prof = renameProfile(deps.profilesDir, from, to);
  try {
    const keychain = deps.migrateCredential(fromDir, prof.dir);
    return { dir: prof.dir, sessionsUpdated: deps.renameSessions(from, to), keychain };
  } catch (e) {
    renameProfile(deps.profilesDir, to, from); // roll back
    throw e;
  }
}

export interface DeviceSummary {
  id: string;
  name: string;
  hasApnsToken: boolean;
  apnsEnv: string;
  createdAt: string;
}

export function resolveDeviceId(devices: DeviceSummary[], prefix: string): string {
  const hits = devices.filter((d) => d.id.startsWith(prefix));
  if (hits.length === 0) throw new Error(`device not found: ${prefix}`);
  if (hits.length > 1) throw new Error(`ambiguous id (${hits.length} matches): ${prefix}`);
  return hits[0]!.id;
}

export function formatDeviceRow(d: DeviceSummary): string {
  const token = d.hasApnsToken ? `APNs:${d.apnsEnv}` : "APNs:none";
  return `${d.id.slice(0, 8)}  ${d.name.padEnd(16)} ${token.padEnd(16)} ${d.createdAt}`;
}

/** Validate an http/https URL and strip trailing slashes. Empty string means "not set", so let it through. */
function normalizeHttpUrl(raw: string, label: string): string {
  if (raw === "") return "";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`invalid ${label} (must start with http:// or https://): ${raw}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`invalid ${label} (only http/https is supported): ${raw}`);
  }
  return raw.replace(/\/+$/, "");
}

/** Validate and normalize the relay URL. Empty string means push is disabled, so let it through. */
export function normalizeRelayUrl(raw: string): string {
  return normalizeHttpUrl(raw, "relay URL");
}

/** Server URL embedded in pairing QR codes. Empty string means "fall back to hostname", so let it through. */
export function normalizeServerUrl(raw: string): string {
  return normalizeHttpUrl(raw, "server URL");
}

// ---- HTTP client (calls the daemon's REST API) ----

function cliToken(secretFile: string): string {
  if (!fs.existsSync(secretFile)) {
    throw new Error("Daemon is not initialized. Run `tiny serve` once first");
  }
  return fs.readFileSync(secretFile, "utf8").trim();
}

async function api(pathname: string, init: RequestInit = {}): Promise<unknown> {
  const p = tinyPaths();
  const token = cliToken(p.secretFile);
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${p.port}${pathname}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        // One connection per call. `tiny attach` blocks in spawnSync for as long as the CLI runs;
        // by then tinyd has closed the idle keep-alive socket, and the first call after the CLI
        // exits failed on that dead socket with "Cannot connect" (measured: detach was skipped,
        // the next call went through on a fresh socket)
        Connection: "close",
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new Error(`Cannot connect to the daemon (port ${p.port}). Start it with \`tiny serve\` or \`tiny daemon install\``);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(`API ${res.status}: ${body.error ?? pathname}`);
  }
  return res.json();
}

/** GET /v1/health (no auth). Returns null when the daemon is down. Used by setup's startup wait and by doctor */
async function fetchHealth(port: number, timeoutMs = 2000): Promise<{ version: string } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return { version: typeof body.version === "string" ? body.version : "unknown" };
  } catch {
    return null;
  }
}

/** Wait for health to respond right after daemon install ((1s-timeout fetch + 0.5s sleep) x 20 = up to ~30s) */
async function waitHealthy(port: number): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    if (await fetchHealth(port, 1000)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function sameFile(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}

// ---- CLI definition ----

const program = new Command()
  .name("tiny")
  .description("tiny: drive coding agents on your Mac from your iPhone")
  .version(TINY_VERSION);

program.command("serve").description("run the daemon in the foreground").action(async () => {
  const { startServer } = await import("./server.js");
  const srv = await startServer();
  console.log(`[tinyd] listening on ${srv.url} (port ${srv.port})`);
});

program
  .command("ls")
  .description("list sessions")
  .option("-a, --all", "include archived sessions")
  .action(async (opts: { all?: boolean }) => {
    const { sessions } = (await api("/v1/sessions")) as { sessions: SessionRecord[] };
    const archived = opts.all
      ? ((await api("/v1/sessions?archived=true")) as { sessions: SessionRecord[] }).sessions
      : [];
    const all = [...sessions, ...archived];
    if (all.length === 0) {
      console.log("No sessions");
      return;
    }
    for (const s of all) {
      const mark = s.archivedAt ? "  [archived]" : "";
      console.log(`${s.id.slice(0, 8)}  ${s.status.padEnd(11)} ${s.profile.padEnd(10)} ${s.title ?? "(untitled)"}  ${s.cwd}${mark}`);
    }
  });

program
  .command("new")
  .description("create a new session")
  .requiredOption("--profile <name>", "profile name")
  .option("--cwd <dir>", "working directory", process.cwd())
  .option("--mode <mode>", "permission mode: default|acceptEdits|bypassPermissions", "default")
  .action(async (opts: { profile: string; cwd: string; mode: string }) => {
    const s = (await api("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ profile: opts.profile, cwd: path.resolve(opts.cwd), permissionMode: opts.mode }),
    })) as SessionRecord;
    console.log(`Created: ${s.id}`);
  });

program
  .command("attach <idPrefix>")
  .description("open the session in the agent's own CLI (e.g. claude --resume; handed back on exit)")
  .action(async (idPrefix: string) => {
    const p = tinyPaths();
    // Resolve from both lists so archived sessions can be attached to as well
    const { sessions } = (await api("/v1/sessions")) as { sessions: SessionRecord[] };
    const { sessions: archived } = (await api("/v1/sessions?archived=true")) as { sessions: SessionRecord[] };
    const id = resolveSessionId([...sessions, ...archived], idPrefix);
    const session = (await api(`/v1/sessions/${id}`)) as SessionRecord;
    const cmd = buildAttachCommand(session, p.profilesDir);
    await api(`/v1/sessions/${id}/detach`, { method: "POST", body: JSON.stringify({ detached: true }) });
    try {
      const r = spawnSync(cmd.bin, cmd.args, { cwd: cmd.cwd, env: cmd.env as NodeJS.ProcessEnv, stdio: "inherit" });
      if (r.error) throw r.error;
    } finally {
      // The terminal is gone: hand the session back, then say so (the list shows "Closed" until
      // the phone sends or the CLI resumes). Both are attempted even if one fails; the first
      // failure is the one reported
      const handBack = [
        () => api(`/v1/sessions/${id}/detach`, { method: "POST", body: JSON.stringify({ detached: false }) }),
        () => api("/v1/sessions/cli-ended", {
          method: "POST", body: JSON.stringify({ agentSessionId: session.agentSessionId }),
        }),
      ];
      let failure: unknown = null;
      for (const step of handBack) {
        try {
          await step();
        } catch (err) {
          failure ??= err;
        }
      }
      if (failure !== null) throw failure;
    }
  });

program
  .command("handoff")
  .description("hand the Claude Code session you are in over to tiny (the reverse of `tiny attach`)")
  .option("--auto", "hook mode: never fail the caller (always exits 0)")
  .option("--ended", "session ended: mark it closed (drop it if it never got a single event)")
  .option("--profile <name>", "profile to adopt into (default: the one pointing at CLAUDE_CONFIG_DIR)")
  .option("--session <id>", "agent session id (default: $CLAUDE_CODE_SESSION_ID)")
  .option("--config-dir <dir>", "CLAUDE_CONFIG_DIR to adopt from (default: $CLAUDE_CONFIG_DIR or ~/.claude)")
  .action(async (opts: {
    auto?: boolean; ended?: boolean; profile?: string; session?: string; configDir?: string;
  }) => {
    // `tiny live on` installs the hook for a config dir the SDK also reads, so this runs inside
    // tiny's own agents too — where the session is already tiny's and adopting it would add a ghost row
    if (isInsideTinyAgent(process.env)) {
      if (!opts.auto) console.log("Already inside a tiny session (TINY_SESSION_ID is set) — nothing to hand off.");
      return;
    }
    try {
      const env = resolveHandoffInput(process.env);
      const configDir = opts.configDir ?? env.configDir;
      // In hook mode the payload on stdin carries session_id too, so a Claude Code that stops
      // exporting CLAUDE_CODE_SESSION_ID does not take always-on mode down with it
      const agentSessionId = opts.session ?? env.agentSessionId
        ?? (opts.auto ? parseHookSessionId(await readStdinBriefly()) : null);
      if (!agentSessionId) {
        throw new Error("no session id (run this inside Claude Code, or pass --session <id>)");
      }
      if (opts.ended) {
        const r = (await api("/v1/sessions/cli-ended", {
          method: "POST",
          body: JSON.stringify({ agentSessionId }),
        })) as { discarded: boolean; closed: boolean };
        if (!opts.auto) console.log(r.discarded ? "Discarded (no activity)" : r.closed ? "Closed" : "Unknown session");
        return;
      }
      const profile = opts.profile ?? ensureHandoffProfile(tinyPaths().profilesDir, configDir);
      const s = (await api("/v1/sessions/adopt", {
        method: "POST",
        body: JSON.stringify({ profile, cwd: process.cwd(), agentSessionId }),
      })) as SessionRecord;
      if (!opts.auto) console.log(`Handed off: ${s.id} (${s.title ?? s.cwd})`);
    } catch (err) {
      // In hook mode a failure must never get in the way of the agent starting up
      const msg = err instanceof Error ? err.message : String(err);
      if (opts.auto) {
        console.error(`[tiny] handoff skipped: ${msg}`);
        return;
      }
      throw err;
    }
  });

// PreToolUse hook installed by `tiny live on`: tells tinyd about a question the CLI is asking, so
// the phone can answer it while it is still on screen. Not meant to be run by hand
program
  .command("question", { hidden: true })
  .description("hook mode: report an AskUserQuestion the CLI is showing")
  .option("--auto", "hook mode: never fail the caller (always exits 0)")
  .action(async (opts: { auto?: boolean }) => {
    // Inside tiny's own agents the question comes through the permission flow instead
    if (isInsideTinyAgent(process.env)) return;
    try {
      const hook = parseQuestionHook(await readStdinBriefly());
      if (!hook) return;
      await api("/v1/questions", {
        method: "POST",
        body: JSON.stringify(hook),
      });
    } catch (err) {
      // A hook that fails must never stand between the person and their question
      const msg = err instanceof Error ? err.message : String(err);
      if (opts.auto) {
        console.error(`[tiny] question not reported: ${msg}`);
        return;
      }
      throw err;
    }
  });

program
  .command("live [state]")
  .description("always hand new Claude Code sessions to tiny (state: on|off; omit to show)")
  .option("--profile <name>", "tiny profile to configure (default: the caller's own config dir)")
  .option("--config-dir <dir>", "CLAUDE_CONFIG_DIR to configure (default: $CLAUDE_CONFIG_DIR or ~/.claude)")
  .action((state: string | undefined, opts: { profile?: string; configDir?: string }) => {
    const paths = tinyPaths();
    // Claude gets hooks; codex / opencode get tinyd's storage scan — one command, per-agent means
    if (opts.profile !== undefined && profileDriver(paths.profilesDir, opts.profile).id !== "claude") {
      if (state === undefined) {
        console.log(`${readProfileLive(paths.profilesDir, opts.profile) ? "on" : "off"}  (${opts.profile}: storage scan)`);
        return;
      }
      if (state !== "on" && state !== "off") throw new Error(`state must be on or off (got ${state})`);
      setProfileLive(paths.profilesDir, opts.profile, state === "on");
      console.log(`Always-handoff is now ${state} (${opts.profile}: tinyd scans the agent's own sessions)`);
      return;
    }
    const configDir = resolveLiveConfigDir(opts, paths.profilesDir);
    const l = tinyLaunch();
    const command = buildHookCommand(l.command, l.args);
    if (state === undefined) {
      console.log(`${readLiveMode(configDir) ? "on" : "off"}  (${configDir})`);
      return;
    }
    if (state !== "on" && state !== "off") throw new Error(`state must be on or off (got ${state})`);
    setLiveMode(configDir, state === "on", command);
    console.log(`Always-handoff is now ${state} (${configDir})`);
  });

// Launched by agents as an MCP server (stdio). Not meant to be run by humans, so hidden from help
program.command("mcp-server", { hidden: true }).action(async () => {
  const { runTinyMcpServer } = await import("./mcp-server.js");
  await runTinyMcpServer();
});

program.command("agents").description("list supported agents").action(() => {
  for (const d of listDrivers()) console.log(`${d.id.padEnd(10)} ${d.label.padEnd(10)} bin=${d.bin}`);
});

program
  .command("doctor")
  .description("check node, the launchd daemon, server URL, push, and each supported agent CLI / profile")
  .action(async () => {
    const p = tinyPaths();
    const report = await collectDoctor({
      version: TINY_VERSION,
      nodeVersion: process.version,
      execPath: process.execPath,
      entry: tinyEntry(),
      installed: readInstalledDaemon(),
      health: () => fetchHealth(p.port),
      port: p.port,
      settings: loadSettings(p),
      tailscaleIp: detectTailscaleIp(),
      drivers: listDrivers(),
      findOnPath: (bin) => findOnPath(bin),
      profiles: listProfiles(p.profilesDir),
      fileExists: (f) => fs.existsSync(f),
      sameFile,
      alwaysHandoff: alwaysHandoffTargets(
        listProfiles(p.profilesDir),
        process.env.CLAUDE_CONFIG_DIR ?? defaultClaudeConfigDir(),
        undefined,
        (name) => readProfileLive(p.profilesDir, name),
      ),
      peerInboxes: summarizePeerInboxes(process.env.CLAUDE_CONFIG_DIR ?? defaultClaudeConfigDir()),
    });
    console.log(formatDoctorReport(report));
    if (!report.ok) process.exitCode = 1;
  });

program
  .command("setup")
  .description("one-shot setup: check prerequisites → profile + login → server URL → launchd daemon → pairing QR")
  .option("--agent <id>", "agent to set up (see `tiny agents`)", "claude")
  .option("--profile <name>", "profile name (default: the agent id)")
  .action(async (opts: { agent: string; profile?: string }) => {
    const p = tinyPaths();
    await runSetup(
      {
        nodeVersion: process.version,
        drivers: listDrivers(),
        findOnPath: (bin) => findOnPath(bin),
        profiles: () => listProfiles(p.profilesDir),
        addProfile: (name, agent) => {
          addProfile(p.profilesDir, name, agent);
        },
        login: (name) => {
          runProfileLogin(name);
        },
        settings: () => loadSettings(p),
        saveServerUrl: (url) => {
          saveSettings(p, { serverUrl: normalizeServerUrl(url) });
        },
        tailscaleIp: detectTailscaleIp,
        port: p.port,
        installDaemon,
        waitHealthy: () => waitHealthy(p.port),
        showPairing: showPairingQr,
        log: (line) => console.log(line),
      },
      { agent: opts.agent, profile: opts.profile ?? opts.agent },
    );
  });

const profiles = program.command("profiles").description("manage agent account profiles");
profiles.command("ls").action(() => {
  const p = tinyPaths();
  for (const prof of listProfiles(p.profilesDir)) {
    console.log(formatProfileRow(prof));
  }
});
profiles
  .command("add <name>")
  .option("--agent <id>", "agent to run in this profile (see `tiny agents`)", "claude")
  .action((name: string, opts: { agent: string }) => {
    const p = tinyPaths();
    const prof = addProfile(p.profilesDir, name, opts.agent);
    console.log(`Created: ${prof.dir} (${prof.label})\nNext, log in with \`tiny profiles login ${name}\``);
  });
profiles.command("rename <old> <new>").action((from: string, to: string) => {
  const p = tinyPaths();
  const db = openDb(p.dbFile);
  try {
    const stores = createStores(db);
    const r = runProfileRename(
      {
        profilesDir: p.profilesDir,
        runningProfiles: () => stores.sessions.list("running").map((s) => s.profile),
        renameSessions: (a, b) => stores.sessions.renameProfile(a, b),
        migrateCredential: (fromDir, toDir) =>
          migrateClaudeCredential({ fromDir, toDir, account: os.userInfo().username }),
      },
      from,
      to,
    );
    const cred = r.keychain === "migrated" ? "keychain credential moved" : "no keychain credential to move";
    console.log(`Renamed ${from} -> ${to}\n  dir: ${r.dir}\n  sessions updated: ${r.sessionsUpdated}\n  ${cred}`);
  } finally {
    db.close();
  }
});
/** Run the agent's login interactively under the given profile (inherits the terminal). Called from `profiles login` and `setup` */
function runProfileLogin(name: string): void {
  const p = tinyPaths();
  const dir = profileDir(p.profilesDir, name);
  const driver = profileDriver(p.profilesDir, name);
  const cmd = driver.login();
  const r = spawnSync(cmd.bin, cmd.args, {
    env: agentEnv(driver, dir) as NodeJS.ProcessEnv,
    stdio: "inherit",
  });
  if (r.error) throw r.error;
}

profiles.command("login <name>").action(async (name: string) => {
  runProfileLogin(name);
  await seedAcpChoices(name);
});

/**
 * ACP agents report their model / effort choices only over a live session, so cache them right
 * after a login; the app's pickers then fill in without waiting for the first turn.
 */
async function seedAcpChoices(name: string): Promise<void> {
  const p = tinyPaths();
  const driver = profileDriver(p.profilesDir, name);
  if (driver.adapter !== "acp") return;
  const dir = profileDir(p.profilesDir, name);
  if (!driver.isLoggedIn(dir)) return;
  const c = await fetchAcpChoices(driver, dir);
  console.log(
    c
      ? `Cached ${c.models.length} model choice(s) and ${c.efforts.length} effort level(s) for the app`
      : "Could not read model choices yet; they fill in after the first turn",
  );
}

/** Issue a pairing code and print the QR (used by `tiny pair` and at the end of `tiny setup`) */
async function showPairingQr(): Promise<void> {
  const started = (await api("/v1/pair/start", { method: "POST", body: "{}" })) as {
    code: string; url: string; expiresAt: string;
  };
  const payload = JSON.stringify({ url: started.url, code: started.code });
  qrcode.generate(payload, { small: true });
  console.log(`URL:  ${started.url}\nCODE: ${started.code} (valid for 10 minutes)`);
}

program.command("pair").description("issue a pairing code for your iPhone").action(showPairingQr);

const devicesCmd = program.command("devices").description("list paired devices").action(async () => {
  const { devices } = (await api("/v1/devices")) as { devices: DeviceSummary[] };
  if (devices.length === 0) {
    console.log("No paired devices (add one with `tiny pair`)");
    return;
  }
  for (const d of devices) console.log(formatDeviceRow(d));
});

devicesCmd
  .command("revoke <ids...>")
  .description("revoke paired devices by id prefix (their tokens stop working immediately)")
  .action(async (ids: string[]) => {
    const { devices } = (await api("/v1/devices")) as { devices: DeviceSummary[] };
    for (const prefix of ids) {
      const id = resolveDeviceId(devices, prefix);
      await api(`/v1/devices/${id}`, { method: "DELETE" });
      console.log(`revoked: ${id}`);
    }
  });

program
  .command("config")
  .description("show or change the server URL embedded in pairing QR codes")
  .option(
    "--server-url <url>",
    "URL the iPhone uses to reach this Mac (e.g. your Tailscale IP; empty string to fall back to hostname)",
  )
  .action((opts: { serverUrl?: string }) => {
    const paths = tinyPaths();
    const s =
      opts.serverUrl !== undefined
        ? saveSettings(paths, { serverUrl: normalizeServerUrl(opts.serverUrl) })
        : loadSettings(paths);
    console.log(`serverUrl : ${s.serverUrl === "" ? "(not set — pairing QR uses http://<hostname>:<port>)" : s.serverUrl}`);
    console.log("Applies to new pairings only; no daemon restart needed");
  });

const push = program.command("push").description("push notification settings and test delivery");

push
  .command("config")
  .description("show or change the relay URL and whether push is enabled")
  .option("--relay <url>", "base URL of the push relay (empty string to disable)")
  .option("--enable", "enable push")
  .option("--disable", "disable push")
  .action((opts: { relay?: string; enable?: boolean; disable?: boolean }) => {
    const paths = tinyPaths();
    if (opts.enable && opts.disable) throw new Error("--enable and --disable cannot be used together");
    const patch: { relayUrl?: string; pushEnabled?: boolean } = {};
    if (opts.relay !== undefined) patch.relayUrl = normalizeRelayUrl(opts.relay);
    if (opts.enable) patch.pushEnabled = true;
    if (opts.disable) patch.pushEnabled = false;
    const s = Object.keys(patch).length > 0 ? saveSettings(paths, patch) : loadSettings(paths);
    console.log(`relayUrl    : ${s.relayUrl === "" ? "(not set)" : s.relayUrl}`);
    console.log(`pushEnabled : ${s.pushEnabled}`);
    if (s.pushEnabled && s.relayUrl === "") {
      console.log("Note: push will not be delivered because the relay URL is not set");
    }
  });

push
  .command("test")
  .description("send a test notification to all paired devices")
  .action(async () => {
    const { results } = (await api("/v1/push/test", { method: "POST" })) as {
      results: Array<{ ok?: boolean; status?: number; reason?: string; error?: string }>;
    };
    if (results.length === 0) {
      console.log("No devices with an APNs token (check with `tiny devices`)");
      return;
    }
    for (const r of results) {
      if (r.ok) console.log("OK: accepted by APNs");
      else console.log(`NG: status=${r.status ?? "-"} reason=${r.reason ?? r.error ?? "-"}`);
    }
  });

const daemon = program.command("daemon").description("manage the launchd agent");
daemon.command("install").action(() => {
  console.log(installDaemon());
});
daemon.command("uninstall").action(() => {
  console.log(uninstallDaemon());
});

/** Whether this file is the launched entry (false when imported from tests or other modules). npm's bin is a symlink at `.../bin/tiny`, so compare by realpath, not by name */
function isMainModule(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  program.parseAsync(process.argv).catch((err: unknown) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
