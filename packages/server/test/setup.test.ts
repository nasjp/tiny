import { describe, expect, it } from "vitest";
import { EMPTY_CAPABILITIES, type AgentDriver } from "../src/agents/index.js";
import type { ProfileInfo } from "../src/profiles.js";
import { runSetup, type SetupDeps } from "../src/setup.js";

function driver(id: string, bin: string): AgentDriver {
  return {
    id, label: id, bin, adapter: "acp", homeEnv: () => ({}), stripEnv: [], isLoggedIn: () => true,
    login: () => ({ bin, args: [] }), attach: () => ({ bin, args: [] }), capabilities: () => EMPTY_CAPABILITIES,
  };
}

function profile(name: string, agent: string, loggedIn: boolean): ProfileInfo {
  return { name, dir: `/p/${name}`, loggedIn, agent, label: agent, capabilities: EMPTY_CAPABILITIES, defaultModel: null, defaultEffort: null, email: null };
}

function harness(over: Partial<SetupDeps> = {}) {
  const calls: string[] = [];
  let profiles: ProfileInfo[] = [];
  let serverUrl = "";
  const deps: SetupDeps = {
    nodeVersion: "v22.12.0",
    drivers: [driver("claude", "claude"), driver("codex", "codex")],
    findOnPath: (bin) => (bin === "claude" ? "/Users/u/.bun/bin/claude" : null),
    profiles: () => profiles,
    addProfile: (name, agent) => { calls.push(`add ${name} ${agent}`); profiles = [...profiles, profile(name, agent, false)]; },
    login: (name) => { calls.push(`login ${name}`); profiles = profiles.map((p) => (p.name === name ? { ...p, loggedIn: true } : p)); },
    settings: () => ({ relayUrl: "", pushEnabled: true, serverUrl }),
    saveServerUrl: (url) => { calls.push(`serverUrl ${url}`); serverUrl = url; },
    tailscaleIp: () => "100.101.102.103",
    port: 7777,
    installDaemon: () => { calls.push("installDaemon"); return "Installed"; },
    waitHealthy: async () => { calls.push("waitHealthy"); return true; },
    showPairing: async () => { calls.push("pair"); },
    log: () => {},
    ...over,
  };
  return { deps, calls, setProfiles: (p: ProfileInfo[]) => { profiles = p; }, setServerUrl: (u: string) => { serverUrl = u; } };
}

describe("runSetup", () => {
  it("first run: profile creation → login → Tailscale URL → daemon → wait for startup → QR, in order", async () => {
    const h = harness();
    await runSetup(h.deps, { agent: "claude", profile: "claude" });
    expect(h.calls).toEqual([
      "add claude claude",
      "login claude",
      "serverUrl http://100.101.102.103:7777",
      "installDaemon",
      "waitHealthy",
      "pair",
    ]);
  });

  it("keeps an existing logged-in profile and configured serverUrl (skips add / login / serverUrl)", async () => {
    const h = harness();
    h.setProfiles([profile("work", "claude", true)]);
    h.setServerUrl("http://100.1.1.1:7777");
    await runSetup(h.deps, { agent: "claude", profile: "work" });
    expect(h.calls).toEqual(["installDaemon", "waitHealthy", "pair"]);
  });

  it("without Tailscale, leaves serverUrl alone and only prints guidance", async () => {
    const lines: string[] = [];
    const h = harness({ tailscaleIp: () => null, log: (l) => lines.push(l) });
    await runSetup(h.deps, { agent: "claude", profile: "claude" });
    expect(h.calls).not.toContainEqual(expect.stringContaining("serverUrl"));
    expect(lines.join("\n")).toContain("tiny config --server-url");
  });

  it("guides without stopping when still logged out after login", async () => {
    const lines: string[] = [];
    const h = harness({ login: () => {}, log: (l) => lines.push(l) });
    await runSetup(h.deps, { agent: "claude", profile: "claude" });
    expect(lines.join("\n")).toContain("tiny profiles login claude");
    expect(h.calls).toContain("pair");
  });

  it("continues through daemon install / pair even when login throws", async () => {
    const lines: string[] = [];
    const h = harness({
      login: () => { throw new Error("boom: no browser available"); },
      log: (l) => lines.push(l),
    });
    await expect(runSetup(h.deps, { agent: "claude", profile: "claude" })).resolves.toBeUndefined();
    expect(h.calls).toContain("installDaemon");
    expect(h.calls).toContain("pair");
    expect(lines.join("\n")).toContain("tiny profiles login");
  });

  it("throws on old node / unknown agent / CLI not installed / profile agent mismatch / daemon startup failure", async () => {
    await expect(runSetup(harness({ nodeVersion: "v20.0.0" }).deps, { agent: "claude", profile: "claude" })).rejects.toThrow(/Node 22/);
    await expect(runSetup(harness().deps, { agent: "droid", profile: "d" })).rejects.toThrow(/unknown agent: droid \(known: claude, codex\)/);
    await expect(runSetup(harness().deps, { agent: "codex", profile: "cx" })).rejects.toThrow(/`codex` not found on PATH/);
    const mismatch = harness();
    mismatch.setProfiles([profile("work", "codex", true)]);
    await expect(runSetup(mismatch.deps, { agent: "claude", profile: "work" })).rejects.toThrow(/profile work runs codex/);
    await expect(runSetup(harness({ waitHealthy: async () => false }).deps, { agent: "claude", profile: "claude" })).rejects.toThrow(/did not start/);
  });
});
