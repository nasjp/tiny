import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tinyPaths } from "../src/config.js";
import { loadSettings, saveSettings, settingsFile } from "../src/settings.js";

describe("tinyd settings", () => {
  let home: string;
  let paths: ReturnType<typeof tinyPaths>;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-settings-"));
    paths = tinyPaths({ TINY_HOME: home });
  });

  it("defaults when the file is absent (empty relayUrl, push enabled, empty serverUrl)", () => {
    const s = loadSettings(paths, {});
    expect(s).toEqual({ relayUrl: "", pushEnabled: true, serverUrl: "" });
  });

  it("a saved serverUrl reads back (other fields stay default)", () => {
    saveSettings(paths, { serverUrl: "http://100.101.102.103:7777" });
    const s = loadSettings(paths, {});
    expect(s.serverUrl).toBe("http://100.101.102.103:7777");
    expect(s.relayUrl).toBe("");
    expect(s.pushEnabled).toBe(true);
  });

  it("the TINY_SERVER_URL env var overrides the config file's serverUrl", () => {
    saveSettings(paths, { serverUrl: "http://file.example.com:7777" });
    const s = loadSettings(paths, { TINY_SERVER_URL: "http://env.example.com:7777" });
    expect(s.serverUrl).toBe("http://env.example.com:7777");
  });

  it("saved settings read back", () => {
    saveSettings(paths, { relayUrl: "https://relay.example.com" });
    expect(loadSettings(paths, {}).relayUrl).toBe("https://relay.example.com");
    expect(loadSettings(paths, {}).pushEnabled).toBe(true);
  });

  it("a partial update keeps the other fields", () => {
    saveSettings(paths, { relayUrl: "https://relay.example.com" });
    saveSettings(paths, { pushEnabled: false });
    const s = loadSettings(paths, {});
    expect(s.relayUrl).toBe("https://relay.example.com");
    expect(s.pushEnabled).toBe(false);
  });

  it("the config file is readable and writable by the owner only", () => {
    saveSettings(paths, { relayUrl: "https://relay.example.com" });
    expect(fs.statSync(settingsFile(paths)).mode & 0o777).toBe(0o600);
  });

  it("env overrides the config file (for development)", () => {
    saveSettings(paths, { relayUrl: "https://file.example.com" });
    const s = loadSettings(paths, { TINY_RELAY_URL: "https://env.example.com", TINY_PUSH_ENABLED: "0" });
    expect(s.relayUrl).toBe("https://env.example.com");
    expect(s.pushEnabled).toBe(false);
  });

  it("broken JSON falls back to defaults without crashing", () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(settingsFile(paths), "{ broken");
    expect(loadSettings(paths, {})).toEqual({ relayUrl: "", pushEnabled: true, serverUrl: "" });
  });
});
