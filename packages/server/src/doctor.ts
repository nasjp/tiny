import type { AgentDriver } from "./agents/index.js";
import type { InstalledDaemon } from "./daemon.js";
import type { TinyEntry } from "./entry.js";
import type { ProfileInfo } from "./profiles.js";
import type { TinySettings } from "./settings.js";

export type CheckStatus = "ok" | "warn" | "ng";

export interface DoctorCheck {
  status: CheckStatus;
  name: string;
  detail: string;
  /** How to fix (a command). Present for warn / ng */
  hint?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  /** No ng at all */
  ok: boolean;
}

/** The outside world diagnostics use. The CLI passes the real thing, tests pass fakes */
export interface DoctorDeps {
  version: string;
  nodeVersion: string;
  execPath: string;
  entry: TinyEntry;
  installed: InstalledDaemon | null;
  /** GET /v1/health. Null when unreachable */
  health: () => Promise<{ version: string } | null>;
  port: number;
  settings: TinySettings;
  tailscaleIp: string | null;
  /** The registry (listDrivers() in src/agents/index.ts). droid / gemini are unregistered so they don't appear */
  drivers: AgentDriver[];
  findOnPath: (bin: string) => string | null;
  profiles: ProfileInfo[];
  fileExists: (p: string) => boolean;
  /** Whether two paths are the same file (realpath comparison; string comparison in tests) */
  sameFile: (a: string, b: string) => boolean;
  /** Whether `tiny live` is on (the SessionStart/SessionEnd hooks are installed in the agent's settings.json) */
  alwaysHandoff: boolean;
}

export const MIN_NODE_MAJOR = 22;

function nodeMajor(v: string): number {
  return Number(/^v?(\d+)/.exec(v)?.[1] ?? 0);
}

function checkDaemonPlist(d: DoctorDeps): DoctorCheck {
  const name = "daemon (launchd)";
  if (!d.installed) {
    return { status: "warn", name, detail: "not installed (tinyd will not start at login)", hint: "tiny daemon install  (or: tiny setup)" };
  }
  const args = d.installed.programArguments;
  const missing = args.filter((a) => a.startsWith("/") && !d.fileExists(a));
  if (missing.length > 0) {
    return { status: "ng", name, detail: `plist points to a missing file: ${missing.join(", ")}`, hint: "tiny daemon install  (re-bake the paths after upgrading tiny or Node)" };
  }
  // ProgramArguments = [node, (tsx), entry, "serve"], so the entry is second from the end
  const entryArg = args.length >= 2 ? args[args.length - 2]! : "";
  if (!d.sameFile(entryArg, d.entry.file)) {
    return { status: "warn", name, detail: `plist runs a different tiny: ${entryArg} (this one: ${d.entry.file})`, hint: "tiny daemon install" };
  }
  return { status: "ok", name, detail: `${d.installed.file} → ${args.join(" ")}` };
}

async function checkDaemonRunning(d: DoctorDeps): Promise<DoctorCheck> {
  const name = "daemon (running)";
  const h = await d.health();
  if (!h) return { status: "ng", name, detail: `not reachable on http://127.0.0.1:${d.port}`, hint: "tiny daemon install  (foreground: tiny serve; logs: ~/.tiny/tinyd.err.log)" };
  if (h.version !== d.version) {
    return { status: "warn", name, detail: `daemon is v${h.version}, this CLI is v${d.version}`, hint: "tiny daemon install  (restarts the daemon on the new version)" };
  }
  return { status: "ok", name, detail: `v${h.version} on port ${d.port}` };
}

function checkServerUrl(d: DoctorDeps): DoctorCheck {
  const name = "server URL";
  if (d.settings.serverUrl !== "") return { status: "ok", name, detail: d.settings.serverUrl };
  if (d.tailscaleIp) {
    return { status: "warn", name, detail: `not set — pairing QR uses http://<hostname>:${d.port} (same Wi-Fi only). Tailscale detected: ${d.tailscaleIp}`, hint: `tiny config --server-url http://${d.tailscaleIp}:${d.port}` };
  }
  return { status: "warn", name, detail: `not set — pairing QR uses http://<hostname>:${d.port} (same Wi-Fi only; install Tailscale to reach the Mac from anywhere)`, hint: "tiny config --server-url http://<ip>:7777" };
}

function checkPush(d: DoctorDeps): DoctorCheck {
  const name = "push";
  if (!d.settings.pushEnabled) return { status: "warn", name, detail: "disabled", hint: "tiny push config --enable" };
  if (d.settings.relayUrl === "") return { status: "warn", name, detail: "relay URL not set (no push notifications)", hint: "tiny push config --relay <url>" };
  return { status: "ok", name, detail: `relay ${d.settings.relayUrl}` };
}

function checkAlwaysHandoff(d: DoctorDeps): DoctorCheck {
  const name = "always handoff";
  return d.alwaysHandoff
    ? { status: "ok", name, detail: "on (every new session is handed to tiny automatically)" }
    : { status: "ok", name, detail: "off (manual `tiny handoff` only; enable with tiny live on)" };
}

function checkAgent(d: DoctorDeps, driver: AgentDriver): DoctorCheck {
  const name = `agent ${driver.label}`;
  const bin = d.findOnPath(driver.bin);
  const profiles = d.profiles.filter((p) => p.agent === driver.id);
  const list = profiles.map((p) => `${p.name} (${p.loggedIn ? "logged in" : "not logged in"})`).join(", ");
  if (!bin) {
    return { status: "warn", name, detail: `not installed (\`${driver.bin}\` not on PATH)${profiles.length > 0 ? `; profiles: ${list}` : ""}` };
  }
  if (profiles.length === 0) {
    return { status: "warn", name, detail: `${bin}; no profile`, hint: `tiny profiles add <name> --agent ${driver.id} && tiny profiles login <name>` };
  }
  const loggedOut = profiles.filter((p) => !p.loggedIn);
  if (loggedOut.length === profiles.length) {
    return { status: "warn", name, detail: `${bin}; profiles: ${list}`, hint: `tiny profiles login ${loggedOut[0]!.name}` };
  }
  return { status: "ok", name, detail: `${bin}; profiles: ${list}` };
}

export async function collectDoctor(d: DoctorDeps): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  checks.push({ status: "ok", name: "tiny", detail: `v${d.version} (${d.entry.isSource ? "source: " : ""}${d.entry.file})` });
  const major = nodeMajor(d.nodeVersion);
  checks.push(
    major >= MIN_NODE_MAJOR
      ? { status: "ok", name: "node", detail: `${d.nodeVersion} (${d.execPath})` }
      : { status: "ng", name: "node", detail: `${d.nodeVersion} (${d.execPath}) — Node ${MIN_NODE_MAJOR}+ required`, hint: "brew install node  (or: mise use -g node@22)" },
  );
  checks.push(checkDaemonPlist(d));
  checks.push(await checkDaemonRunning(d));
  checks.push(checkServerUrl(d));
  checks.push(checkPush(d));
  checks.push(checkAlwaysHandoff(d));
  const agentChecks = d.drivers.map((drv) => checkAgent(d, drv));
  const installedCount = d.drivers.filter((drv) => d.findOnPath(drv.bin) !== null).length;
  checks.push(
    installedCount > 0
      ? { status: "ok", name: "agents", detail: `${installedCount}/${d.drivers.length} supported agent CLIs installed` }
      : { status: "ng", name: "agents", detail: "no supported agent CLI found on PATH", hint: `install one of: ${d.drivers.map((drv) => drv.bin).join(", ")}` },
  );
  checks.push(...agentChecks);
  return { checks, ok: checks.every((c) => c.status !== "ng") };
}

const PREFIX: Record<CheckStatus, string> = { ok: "[ok]  ", warn: "[warn]", ng: "[NG]  " };

export function formatDoctorReport(r: DoctorReport): string {
  const lines: string[] = [];
  for (const c of r.checks) {
    lines.push(`${PREFIX[c.status]} ${c.name.padEnd(18)} ${c.detail}`);
    if (c.hint) lines.push(`${" ".repeat(26)}→ ${c.hint}`);
  }
  const problems = r.checks.filter((c) => c.status === "ng").length;
  const warnings = r.checks.filter((c) => c.status === "warn").length;
  lines.push("");
  if (problems === 0 && warnings === 0) {
    lines.push("All good");
  } else if (problems === 0) {
    lines.push(`All good, ${warnings} warning(s) (see → hints above)`);
  } else {
    lines.push(`${problems} problem${problems === 1 ? "" : "s"} found${warnings > 0 ? `, ${warnings} warning(s)` : ""}`);
  }
  return lines.join("\n");
}
