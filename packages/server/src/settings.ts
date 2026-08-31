import fs from "node:fs";
import path from "node:path";
import type { TinyPaths } from "./config.js";

export interface TinySettings {
  /** Base URL of the push-relay. Empty string disables push sending. */
  relayUrl: string;
  pushEnabled: boolean;
  /**
   * URL embedded in the pairing QR at which the iPhone can reach this Mac.
   * Empty string means `http://<hostname>:<port>` (assumes mDNS on the same LAN;
   * when going over Tailscale, set the Tailscale IP URL here).
   */
  serverUrl: string;
}

export const DEFAULT_SETTINGS: TinySettings = { relayUrl: "", pushEnabled: true, serverUrl: "" };

export function settingsFile(paths: TinyPaths): string {
  return path.join(paths.home, "config.json");
}

/**
 * Reads ~/.tiny/config.json. Since only PATH is baked into the launchd plist,
 * this file is the source of truth for settings. env works only as an override for local development.
 */
export function loadSettings(
  paths: TinyPaths,
  env: Record<string, string | undefined> = process.env,
): TinySettings {
  const settings: TinySettings = { ...DEFAULT_SETTINGS };
  const file = settingsFile(paths);
  if (fs.existsSync(file)) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<TinySettings>;
      if (typeof raw.relayUrl === "string") settings.relayUrl = raw.relayUrl;
      if (typeof raw.pushEnabled === "boolean") settings.pushEnabled = raw.pushEnabled;
      if (typeof raw.serverUrl === "string") settings.serverUrl = raw.serverUrl;
    } catch (err) {
      console.error(`[tinyd] failed to read ${file} (using defaults):`, err);
    }
  }
  if (env.TINY_RELAY_URL) settings.relayUrl = env.TINY_RELAY_URL;
  if (env.TINY_PUSH_ENABLED === "0") settings.pushEnabled = false;
  if (env.TINY_SERVER_URL) settings.serverUrl = env.TINY_SERVER_URL;
  return settings;
}

export function saveSettings(paths: TinyPaths, patch: Partial<TinySettings>): TinySettings {
  const current = loadSettings(paths, {});
  const next: TinySettings = {
    relayUrl: patch.relayUrl ?? current.relayUrl,
    pushEnabled: patch.pushEnabled ?? current.pushEnabled,
    serverUrl: patch.serverUrl ?? current.serverUrl,
  };
  fs.mkdirSync(paths.home, { recursive: true });
  fs.writeFileSync(settingsFile(paths), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}
