import type { AgentDriver } from "./agents/index.js";
import { MIN_NODE_MAJOR } from "./doctor.js";
import type { ProfileInfo } from "./profiles.js";
import type { TinySettings } from "./settings.js";

export interface SetupOptions {
  agent: string;
  profile: string;
}

/** The outside world setup touches. The CLI passes the real thing, tests pass fakes. login and showPairing are interactive (inherit the terminal) */
export interface SetupDeps {
  nodeVersion: string;
  drivers: AgentDriver[];
  findOnPath: (bin: string) => string | null;
  profiles: () => ProfileInfo[];
  addProfile: (name: string, agent: string) => void;
  login: (name: string) => void;
  settings: () => TinySettings;
  saveServerUrl: (url: string) => void;
  tailscaleIp: () => string | null;
  port: number;
  installDaemon: () => string;
  /** Waits until health responds (up to ~30 seconds). true = it started */
  waitHealthy: () => Promise<boolean>;
  showPairing: () => Promise<void>;
  log: (line: string) => void;
}

/**
 * Single-path setup: prerequisites (node, agent CLI) → profile creation → login → serverUrl (Tailscale) →
 * launchd residency → wait for startup → pairing QR. Steps already done are skipped so repeated runs converge.
 * A failed step throws (the CLI prints it as `Error:`). Only login does not stop on failure; it prints how to do it later
 */
export async function runSetup(d: SetupDeps, opts: SetupOptions): Promise<void> {
  const major = Number(/^v?(\d+)/.exec(d.nodeVersion)?.[1] ?? 0);
  if (major < MIN_NODE_MAJOR) throw new Error(`Node ${MIN_NODE_MAJOR}+ is required (running ${d.nodeVersion})`);

  const driver = d.drivers.find((x) => x.id === opts.agent);
  if (!driver) throw new Error(`unknown agent: ${opts.agent} (known: ${d.drivers.map((x) => x.id).join(", ")})`);
  const bin = d.findOnPath(driver.bin);
  if (!bin) throw new Error(`${driver.label} CLI \`${driver.bin}\` not found on PATH. Install it and log in first, then re-run tiny setup`);
  d.log(`[1/5] ${driver.label}: ${bin}`);

  let prof = d.profiles().find((p) => p.name === opts.profile);
  if (prof && prof.agent !== driver.id) {
    throw new Error(`profile ${opts.profile} runs ${prof.agent}, not ${driver.id} (pick another name with --profile)`);
  }
  if (!prof) {
    d.addProfile(opts.profile, driver.id);
    d.log(`[2/5] created profile ${opts.profile} (${driver.label})`);
  } else {
    d.log(`[2/5] profile ${opts.profile} exists`);
  }
  prof = d.profiles().find((p) => p.name === opts.profile);
  if (!prof?.loggedIn) {
    d.log(`[3/5] logging in to ${driver.label} (profile ${opts.profile}) — follow the prompts`);
    try {
      d.login(opts.profile);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      d.log(`      login failed: ${reason}; run \`tiny profiles login ${opts.profile}\` later`);
    }
    prof = d.profiles().find((p) => p.name === opts.profile);
    if (!prof?.loggedIn) d.log(`      still not logged in; run \`tiny profiles login ${opts.profile}\` later`);
  } else {
    d.log(`[3/5] profile ${opts.profile} is logged in`);
  }

  if (d.settings().serverUrl === "") {
    const ip = d.tailscaleIp();
    if (ip) {
      const url = `http://${ip}:${d.port}`;
      d.saveServerUrl(url);
      d.log(`[4/5] server URL: ${url} (Tailscale; the phone reaches this Mac from anywhere)`);
    } else {
      d.log(`[4/5] server URL: not set — pairing QR will use http://<hostname>:${d.port} (same Wi-Fi only). Install Tailscale or run: tiny config --server-url http://<ip>:${d.port}`);
    }
  } else {
    d.log(`[4/5] server URL: ${d.settings().serverUrl}`);
  }

  d.log(`[5/5] ${d.installDaemon()}`);
  if (!(await d.waitHealthy())) {
    throw new Error("the daemon did not start (see ~/.tiny/tinyd.err.log; try `tiny serve` in the foreground)");
  }
  d.log("daemon is up. Scan this QR with the tiny app:");
  await d.showPairing();
}
