import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listDrivers } from "./agents/index.js";
import { tinyPaths } from "./config.js";
import { tinyLaunch, type LaunchCommand } from "./entry.js";
import { findOnPath } from "./which.js";

export const DAEMON_LABEL = "com.tanirell.tinyd";

/** launchd does not have the user's shell environment, so always include at least these */
export const STANDARD_PATH_DIRS: readonly string[] = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

function xmlEscape(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function xmlUnescape(s: string): string {
  return s.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

/**
 * launchd plist. ProgramArguments is just "absolute path to node + entry file + serve" (tsx is not baked in).
 * PATH is set explicitly via EnvironmentVariables (processes under launchd do not inherit the user's shell environment)
 */
export function renderPlist(opts: { label: string; programArguments: string[]; logDir: string; pathEnv: string }): string {
  const args = opts.programArguments.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");
  const logDir = xmlEscape(opts.logDir);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xmlEscape(opts.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${logDir}/tinyd.out.log</string>
  <key>StandardErrorPath</key><string>${logDir}/tinyd.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xmlEscape(opts.pathEnv)}</string>
  </dict>
</dict>
</plist>
`;
}

/** Reads back a plist we wrote ourselves (not a general plist parser; only understands renderPlist's shape) */
export function parsePlistProgramArguments(xml: string): string[] {
  const m = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml);
  if (!m) return [];
  return [...m[1]!.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((x) => xmlUnescape(x[1]!));
}

export function parsePlistPathEnv(xml: string): string {
  const m = /<key>PATH<\/key>\s*<string>([\s\S]*?)<\/string>/.exec(xml);
  return m ? xmlUnescape(m[1]!) : "";
}

/**
 * PATH baked into launchd: node's dir → dirs of registered agents' executables → the user's login-shell PATH → standard dirs.
 * Keeps only directories that exist as absolute paths, in order, without duplicates (this drops vanished paths like
 * old repos or npx caches, and relative entries that snuck into the login-shell PATH (e.g. `.` or `bin` — baked into
 * the plist they could pick up arbitrary commands depending on launchd's current directory)).
 * The login-shell PATH is included because the OpenCode / Cursor bash tools inherit tinyd's PATH as-is
 * (with only standard dirs, pnpm etc. would become invisible inside sessions)
 */
export function daemonPathEnv(opts: {
  execPath: string;
  binDirs: string[];
  shellPath: string | null;
  isDir?: (dir: string) => boolean;
}): string {
  const isDir = opts.isDir ?? ((d: string) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
  const ordered = [
    path.dirname(opts.execPath),
    ...opts.binDirs,
    ...(opts.shellPath ?? "").split(path.delimiter),
    ...STANDARD_PATH_DIRS,
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of ordered) {
    if (d === "" || !path.isAbsolute(d) || seen.has(d) || !isDir(d)) continue;
    seen.add(d);
    out.push(d);
  }
  return out.join(path.delimiter);
}

/**
 * Minimal env passed when spawning the login shell.
 * Avoids inheriting the parent process env (transient PATH entries like npx caches) so only the PATH built by the user's rc files is picked up.
 */
export function loginShellEnv(base: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["HOME", "USER", "LOGNAME", "SHELL", "TERM", "LANG"]) {
    const v = base[k];
    if (v !== undefined) out[k] = v;
  }
  out.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
  return out;
}

const defaultShellRunner = (cmd: string, args: string[]): string =>
  execFileSync(cmd, args, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"], env: loginShellEnv() });

/**
 * PATH resolved via the user's login shell (-lic = also reads rc files). Uses only the last line even if rc prints extra output. null on failure.
 * The shell starts with the minimal env from `loginShellEnv()`, so the calling process's PATH cannot leak in.
 */
export function loginShellPath(shell: string = process.env.SHELL ?? "/bin/zsh", run: (cmd: string, args: string[]) => string = defaultShellRunner): string | null {
  try {
    const last = run(shell, ["-lic", 'printf "\\n%s\\n" "$PATH"']).trim().split("\n").at(-1)?.trim() ?? "";
    // fish prints $PATH space-separated (not :-separated). A result with no separator and only whitespace is unusable as PATH, so return null
    // (a :-separated PATH that merely contains one dir with a space in it is a legitimate PATH and passes through)
    if (!last.includes(path.delimiter) && /\s/.test(last)) return null;
    return last.includes("/") ? last : null;
  } catch {
    return null;
  }
}

export function plistPath(home: string = os.homedir()): string {
  return path.join(home, "Library", "LaunchAgents", `${DAEMON_LABEL}.plist`);
}

export interface InstalledDaemon {
  file: string;
  programArguments: string[];
  pathEnv: string;
}

/** Reads the installed plist (null if absent). doctor checks whether it points at a different tiny than the current one */
export function readInstalledDaemon(home: string = os.homedir()): InstalledDaemon | null {
  const file = plistPath(home);
  if (!fs.existsSync(file)) return null;
  const xml = fs.readFileSync(file, "utf8");
  return { file, programArguments: parsePlistProgramArguments(xml), pathEnv: parsePlistPathEnv(xml) };
}

export interface InstallDaemonDeps {
  /** Home that holds the plist (~/Library/LaunchAgents) */
  home: string;
  /** Where the logs go (~/.tiny) */
  logDir: string;
  /** Command that starts tiny (node + entry point) */
  launch: LaunchCommand;
  /** Dirs holding the registered agents' executables (resolved against the install-time PATH) */
  binDirs: string[];
  shellPath: string | null;
  uid: number;
  launchctl: (args: string[]) => void;
  /** Wait between retries. Default is a synchronous sleep (Atomics.wait blocks the event loop) */
  sleepMs: (ms: number) => void;
}

// CLI only (never call from inside the daemon; it blocks the event loop)
function defaultSleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function defaultInstallDeps(): InstallDaemonDeps {
  const shellPath = loginShellPath();
  // Prefer what the user's login shell sees, to avoid baking in the transient PATH [npx cache etc.] of the process that ran tiny daemon install
  const pathEnv = shellPath ?? process.env.PATH;
  const binDirs = listDrivers()
    .map((d) => findOnPath(d.bin, pathEnv))
    .filter((p): p is string => p !== null)
    .map((p) => path.dirname(p));
  return {
    home: os.homedir(),
    logDir: tinyPaths().home,
    launch: tinyLaunch(),
    binDirs,
    shellPath,
    uid: process.getuid?.() ?? 501,
    launchctl: (args) => { execFileSync("launchctl", args, { stdio: "ignore" }); },
    sleepMs: defaultSleepMs,
  };
}

/**
 * Writes the plist and re-registers it with launchd. Re-run after upgrading tiny or node
 * (the plist bakes in the current entry point and the absolute node path).
 * entry.ts picks the entry point: the stable symlink path when launched via the npm bin, tsx + src/cli.ts during development
 */
export function installDaemon(deps: InstallDaemonDeps = defaultInstallDeps()): string {
  const programArguments = [deps.launch.command, ...deps.launch.args, "serve"];
  const pathEnv = daemonPathEnv({ execPath: deps.launch.command, binDirs: deps.binDirs, shellPath: deps.shellPath });
  fs.mkdirSync(deps.logDir, { recursive: true });
  const file = plistPath(deps.home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, renderPlist({ label: DAEMON_LABEL, programArguments, logDir: deps.logDir, pathEnv }));
  try {
    deps.launchctl(["bootout", `gui/${deps.uid}/${DAEMON_LABEL}`]);
  } catch {
    // Ignore when not registered
  }
  // Right after bootout, launchd may still be cleaning up the old service and bootstrap can fail
  // transiently (seen on a real machine: a second `tiny daemon install` succeeds). Retry up to 10 times, 500ms apart
  const maxAttempts = 10;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      deps.launchctl(["bootstrap", `gui/${deps.uid}`, file]);
      break;
    } catch (err) {
      if (attempt === maxAttempts) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
          `launchctl bootstrap gui/${deps.uid} ${file} failed ${maxAttempts} times (tinyd is not running): ${reason} (try: tiny daemon uninstall && tiny daemon install)`,
        );
      }
      deps.sleepMs(500);
    }
  }
  return [
    `Installed: ${file}`,
    `  runs : ${programArguments.join(" ")}`,
    `  PATH : ${pathEnv.split(path.delimiter).length} dirs (${pathEnv.split(path.delimiter).slice(0, 3).join(":")}:…)`,
    `  logs : ${deps.logDir}/tinyd.out.log`,
    "Re-run `tiny daemon install` after upgrading tiny or Node (the plist bakes their paths)",
  ].join("\n");
}

export function uninstallDaemon(): string {
  const uid = process.getuid?.() ?? 501;
  try {
    execFileSync("launchctl", ["bootout", `gui/${uid}/${DAEMON_LABEL}`], { stdio: "ignore" });
  } catch {
    // Ignore when not registered
  }
  const file = plistPath();
  if (fs.existsSync(file)) fs.rmSync(file);
  return `Uninstalled: ${DAEMON_LABEL}`;
}
