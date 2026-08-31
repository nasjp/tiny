import { execFileSync } from "node:child_process";
import { findOnPath } from "./which.js";

/** CLI of the Mac App Store build of Tailscale (often not on PATH) */
export const TAILSCALE_APP_BIN = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

const defaultRun = (cmd: string, args: string[]): string =>
  execFileSync(cmd, args, { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });

/**
 * This Mac's Tailscale IPv4 (first line of `tailscale ip -4`). Used to auto-suggest the pairing URL over Tailscale.
 * `tailscale` on PATH → otherwise the CLI bundled in Tailscale.app. Null when not running
 */
export function detectTailscaleIp(
  run: (cmd: string, args: string[]) => string = defaultRun,
  findBin: (bin: string) => string | null = (b) => findOnPath(b),
): string | null {
  const bin = findBin("tailscale") ?? TAILSCALE_APP_BIN;
  try {
    const first = run(bin, ["ip", "-4"]).trim().split("\n")[0]?.trim() ?? "";
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(first) ? first : null;
  } catch {
    return null;
  }
}
