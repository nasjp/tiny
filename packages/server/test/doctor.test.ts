import { describe, expect, it } from "vitest";
import { EMPTY_CAPABILITIES, type AgentDriver } from "../src/agents/index.js";
import { collectDoctor, formatDoctorReport, type DoctorDeps } from "../src/doctor.js";
import type { ProfileInfo } from "../src/profiles.js";

function driver(id: string, bin: string): AgentDriver {
  return {
    id, label: id[0]!.toUpperCase() + id.slice(1), bin, adapter: "acp",
    homeEnv: () => ({}), stripEnv: [], isLoggedIn: () => true,
    login: () => ({ bin, args: [] }), attach: () => ({ bin, args: [] }), capabilities: () => EMPTY_CAPABILITIES,
  };
}

function profile(name: string, agent: string, loggedIn: boolean): ProfileInfo {
  return { name, dir: `/p/${name}`, loggedIn, agent, label: agent, capabilities: EMPTY_CAPABILITIES, defaultModel: null, defaultEffort: null, email: null };
}

const ENTRY = "/opt/homebrew/bin/tiny";

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    version: "0.1.0",
    nodeVersion: "v22.12.0",
    execPath: "/opt/homebrew/bin/node",
    entry: { file: ENTRY, isSource: false },
    installed: { file: "/Users/u/Library/LaunchAgents/com.tanirell.tinyd.plist", programArguments: ["/opt/homebrew/bin/node", ENTRY, "serve"], pathEnv: "/opt/homebrew/bin:/usr/bin" },
    health: async () => ({ version: "0.1.0" }),
    port: 7777,
    settings: { relayUrl: "https://relay.example.com", pushEnabled: true, serverUrl: "http://100.101.102.103:7777" },
    tailscaleIp: "100.101.102.103",
    drivers: [driver("claude", "claude"), driver("codex", "codex")],
    findOnPath: (bin) => (bin === "claude" ? "/Users/u/.bun/bin/claude" : null),
    profiles: [profile("work", "claude", true)],
    fileExists: () => true,
    sameFile: (a, b) => a === b,
    alwaysHandoff: false,
    ...over,
  };
}

const byName = (r: Awaited<ReturnType<typeof collectDoctor>>, name: string) => r.checks.find((c) => c.name === name)!;

describe("collectDoctor", () => {
  it("ok when everything is in place (an uninstalled agent warns but the whole stays ok)", async () => {
    const r = await collectDoctor(deps());
    expect(r.ok).toBe(true);
    expect(byName(r, "tiny").detail).toContain("0.1.0");
    expect(byName(r, "node").status).toBe("ok");
    expect(byName(r, "daemon (launchd)").status).toBe("ok");
    expect(byName(r, "daemon (running)").status).toBe("ok");
    expect(byName(r, "server URL").status).toBe("ok");
    expect(byName(r, "agent Claude").status).toBe("ok");
    expect(byName(r, "agent Claude").detail).toContain("work (logged in)");
    expect(byName(r, "agent Codex").status).toBe("warn");
    expect(byName(r, "agent Codex").detail).toContain("not installed");
  });

  it("ng when node is below 22", async () => {
    const r = await collectDoctor(deps({ nodeVersion: "v20.11.0" }));
    expect(byName(r, "node").status).toBe("ng");
    expect(r.ok).toBe(false);
  });

  it("warns and suggests tiny daemon install when the plist is absent", async () => {
    const r = await collectDoctor(deps({ installed: null, health: async () => null }));
    expect(byName(r, "daemon (launchd)").status).toBe("warn");
    expect(byName(r, "daemon (launchd)").hint).toContain("tiny daemon install");
  });

  it("ng when the node or entry the plist points at is gone (node upgraded, tiny reinstalled)", async () => {
    const r = await collectDoctor(deps({ fileExists: (p) => p !== "/opt/homebrew/bin/node" }));
    expect(byName(r, "daemon (launchd)").status).toBe("ng");
    expect(byName(r, "daemon (launchd)").detail).toContain("/opt/homebrew/bin/node");
    expect(byName(r, "daemon (launchd)").hint).toContain("tiny daemon install");
  });

  it("warns when the plist points at a different entry than the current tiny (e.g. an old plist pointing at the repo's src)", async () => {
    const r = await collectDoctor(deps({
      installed: { file: "/x.plist", programArguments: ["/n/node", "/repo/node_modules/tsx/dist/cli.mjs", "/repo/src/cli.ts", "serve"], pathEnv: "" },
    }));
    expect(byName(r, "daemon (launchd)").status).toBe("warn");
    expect(byName(r, "daemon (launchd)").detail).toContain("/repo/src/cli.ts");
  });

  it("ng when the daemon is unreachable, warn when the version differs", async () => {
    const down = await collectDoctor(deps({ health: async () => null }));
    expect(byName(down, "daemon (running)").status).toBe("ng");
    const old = await collectDoctor(deps({ health: async () => ({ version: "0.0.9" }) }));
    expect(byName(old, "daemon (running)").status).toBe("warn");
    expect(byName(old, "daemon (running)").detail).toContain("0.0.9");
  });

  it("suggests a URL when serverUrl is unset and Tailscale is available", async () => {
    const r = await collectDoctor(deps({ settings: { relayUrl: "", pushEnabled: true, serverUrl: "" } }));
    expect(byName(r, "server URL").status).toBe("warn");
    expect(byName(r, "server URL").hint).toContain("tiny config --server-url http://100.101.102.103:7777");
    expect(byName(r, "push").status).toBe("warn");
  });

  it("ng when no agent at all is installed", async () => {
    const r = await collectDoctor(deps({ findOnPath: () => null, profiles: [] }));
    expect(byName(r, "agents").status).toBe("ng");
    expect(r.ok).toBe(false);
  });

  it("installed but no profile / not logged in warns and shows the command", async () => {
    const none = await collectDoctor(deps({ profiles: [] }));
    expect(byName(none, "agent Claude").status).toBe("warn");
    expect(byName(none, "agent Claude").hint).toContain("tiny profiles add");
    const out = await collectDoctor(deps({ profiles: [profile("work", "claude", false)] }));
    expect(byName(out, "agent Claude").status).toBe("warn");
    expect(byName(out, "agent Claude").hint).toContain("tiny profiles login work");
  });

  it("agents missing from the registry do not appear (droid / gemini)", async () => {
    const r = await collectDoctor(deps());
    expect(r.checks.map((c) => c.name)).not.toContain("agent Droid");
  });

  it("reports always handoff on/off", async () => {
    const off = await collectDoctor(deps({ alwaysHandoff: false }));
    expect(byName(off, "always handoff").status).toBe("ok");
    expect(byName(off, "always handoff").detail).toContain("off");
    const on = await collectDoctor(deps({ alwaysHandoff: true }));
    expect(byName(on, "always handoff").status).toBe("ok");
    expect(byName(on, "always handoff").detail).toContain("on");
  });
});

describe("formatDoctorReport", () => {
  it("shows the status as a prefix and the hint on the next line", () => {
    const text = formatDoctorReport({
      ok: false,
      checks: [
        { status: "ok", name: "node", detail: "v22.12.0" },
        { status: "ng", name: "daemon (running)", detail: "not reachable", hint: "tiny daemon install" },
      ],
    });
    expect(text).toContain("[ok]   node");
    expect(text).toContain("[NG]   daemon (running)");
    expect(text).toContain("→ tiny daemon install");
    expect(text.trimEnd().endsWith("1 problem found")).toBe(true);
  });

  it("puts the count in the trailer when there are warns even without ng", () => {
    const text = formatDoctorReport({
      ok: true,
      checks: [
        { status: "ok", name: "node", detail: "v22.12.0" },
        { status: "warn", name: "daemon (running)", detail: "daemon is v0.1.0, this CLI is v0.2.0", hint: "tiny daemon install" },
      ],
    });
    expect(text).toContain("1 warning");
    expect(text.trimEnd().endsWith("All good, 1 warning(s) (see → hints above)")).toBe(true);
  });
});
