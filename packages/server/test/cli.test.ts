import { beforeEach, describe, expect, it } from "vitest";
import { EMPTY_CAPABILITIES } from "../src/agents/index.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  alwaysHandoffTargets,
  buildAttachCommand,
  ensureHandoffProfile,
  formatDeviceRow,
  formatProfileRow,
  normalizeRelayUrl,
  normalizeServerUrl,
  resolveDeviceId,
  isInsideTinyAgent,
  parseHookSessionId,
  resolveHandoffInput,
  resolveLiveConfigDir,
  resolveSessionId,
  runProfileRename,
} from "../src/cli.js";
import { addProfile, listProfiles, readProfileConfigDir, type ProfileInfo } from "../src/profiles.js";
import type { SessionRecord } from "../src/types.js";

function sess(over: Partial<SessionRecord>): SessionRecord {
  return {
    id: "11111111-aaaa-bbbb-cccc-000000000000",
    agentSessionId: "agent-xyz",
    agent: "claude",
    profile: "work",
    cwd: "/tmp/repo",
    permissionMode: "default", model: null, effort: null,
    title: null,
    status: "idle",
    archivedAt: null,
    sourceCursor: null,
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

describe("cli helpers", () => {
  it("buildAttachCommand builds claude --resume", () => {
    const cmd = buildAttachCommand(sess({}), "/home/u/.tiny/profiles");
    expect(cmd.bin).toBe("claude");
    expect(cmd.args).toEqual(["--resume", "agent-xyz"]);
    expect(cmd.cwd).toBe("/tmp/repo");
    expect(cmd.env.CLAUDE_CONFIG_DIR).toBe("/home/u/.tiny/profiles/work");
    expect(cmd.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("throws when agentSessionId is missing", () => {
    expect(() => buildAttachCommand(sess({ agentSessionId: null }), "/p")).toThrow(/no turns/);
  });

  it("buildAttachCommand builds opencode --session and points XDG under the profile", () => {
    const cmd = buildAttachCommand(sess({ agent: "opencode", profile: "oc", agentSessionId: "ses_1" }), "/home/u/.tiny/profiles");
    expect(cmd.bin).toBe("opencode");
    expect(cmd.args).toEqual(["--session", "ses_1"]);
    expect(cmd.env.XDG_DATA_HOME).toBe("/home/u/.tiny/profiles/oc/xdg/data");
    expect(cmd.env.XDG_CONFIG_HOME).toBe("/home/u/.tiny/profiles/oc/xdg/config");
  });

  it("resolveSessionId matches by prefix and throws on ambiguity", () => {
    const a = sess({ id: "aaaa1111-0000-0000-0000-000000000000" });
    const b = sess({ id: "aaab2222-0000-0000-0000-000000000000" });
    expect(resolveSessionId([a, b], "aaaa")).toBe(a.id);
    expect(() => resolveSessionId([a, b], "aa")).toThrow(/ambiguous/);
    expect(() => resolveSessionId([a, b], "zzzz")).toThrow(/not found/);
  });
});

describe("normalizeRelayUrl", () => {
  it("strips trailing slashes", () => {
    expect(normalizeRelayUrl("https://relay.example.com/")).toBe("https://relay.example.com");
  });

  it("passes https through unchanged", () => {
    expect(normalizeRelayUrl("https://a.workers.dev")).toBe("https://a.workers.dev");
  });

  it("also allows http for local testing", () => {
    expect(normalizeRelayUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
  });

  it("rejects strings that are not URLs", () => {
    expect(() => normalizeRelayUrl("relay.example.com")).toThrow(/URL/);
  });

  it("rejects schemes other than http/https", () => {
    expect(() => normalizeRelayUrl("ftp://relay.example.com")).toThrow(/URL/);
  });

  it("allows empty string because it means push is disabled", () => {
    expect(normalizeRelayUrl("")).toBe("");
  });
});

describe("normalizeServerUrl", () => {
  it("allows an http URL with a Tailscale IP and strips the trailing slash", () => {
    expect(normalizeServerUrl("http://100.101.102.103:7777/")).toBe("http://100.101.102.103:7777");
  });

  it("rejects strings that are not URLs", () => {
    expect(() => normalizeServerUrl("100.101.102.103:7777")).toThrow(/server URL/);
  });

  it("allows empty string because it means falling back to hostname", () => {
    expect(normalizeServerUrl("")).toBe("");
  });
});

describe("resolveDeviceId", () => {
  const devices = [
    { id: "e4bc8776-aaaa", name: "iPhone", hasApnsToken: true, apnsEnv: "production", createdAt: "" },
    { id: "e7000000-bbbb", name: "iPhone", hasApnsToken: false, apnsEnv: "sandbox", createdAt: "" },
  ];

  it("returns the full id when the prefix narrows to one device", () => {
    expect(resolveDeviceId(devices, "e4bc")).toBe("e4bc8776-aaaa");
  });

  it("throws on ambiguous or missing prefixes", () => {
    expect(() => resolveDeviceId(devices, "e")).toThrow(/ambiguous/);
    expect(() => resolveDeviceId(devices, "zzz")).toThrow(/not found/);
  });
});

describe("formatDeviceRow", () => {
  it("shows the APNs environment when a token is registered", () => {
    const row = formatDeviceRow({
      id: "abcdef01-2345-6789-abcd-ef0123456789", name: "iPhone",
      hasApnsToken: true, apnsEnv: "sandbox", createdAt: "2026-08-27T00:00:00.000Z",
    });
    expect(row).toContain("abcdef01");
    expect(row).toContain("iPhone");
    expect(row).toContain("sandbox");
  });

  it("clearly marks devices without a token", () => {
    const row = formatDeviceRow({
      id: "abcdef01-2345-6789-abcd-ef0123456789", name: "iPad",
      hasApnsToken: false, apnsEnv: "production", createdAt: "2026-08-27T00:00:00.000Z",
    });
    expect(row).toContain("APNs:none");
  });
});

describe("formatProfileRow", () => {
  const base = {
    dir: "/tmp/p", agent: "claude", label: "Claude", capabilities: EMPTY_CAPABILITIES,
    defaultModel: null, defaultEffort: null,
  };

  it("shows the account email when logged in", () => {
    const row = formatProfileRow({ ...base, name: "profile-3", loggedIn: true, email: "y@example.com" });
    expect(row).toContain("profile-3");
    expect(row).toContain("logged in");
    expect(row).toContain("y@example.com");
  });

  it("shows a hyphen in the email column when not logged in", () => {
    const row = formatProfileRow({ ...base, name: "profile-1", loggedIn: false, email: null });
    expect(row).toContain("not logged in");
    expect(row.trimEnd().endsWith("-")).toBe(true);
  });
});

describe("runProfileRename", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-rename-"));
    fs.mkdirSync(path.join(root, "work"));
  });

  function deps(over: Partial<Parameters<typeof runProfileRename>[0]> = {}) {
    return {
      profilesDir: root,
      runningProfiles: () => [],
      renameSessions: () => 3,
      migrateCredential: () => "migrated" as const,
      ...over,
    };
  }

  it("moves the directory, DB, and Keychain together", () => {
    const seen: string[][] = [];
    const r = runProfileRename(
      deps({
        renameSessions: (a, b) => { seen.push([a, b]); return 3; },
        migrateCredential: (fromDir, toDir) => { seen.push([fromDir, toDir]); return "migrated"; },
      }),
      "work", "profile-3",
    );
    expect(r.dir).toBe(path.join(root, "profile-3"));
    expect(r.sessionsUpdated).toBe(3);
    expect(r.keychain).toBe("migrated");
    expect(seen).toEqual([
      [path.join(root, "work"), path.join(root, "profile-3")],
      ["work", "profile-3"],
    ]);
    expect(fs.existsSync(path.join(root, "profile-3"))).toBe(true);
  });

  it("refuses to move a profile that has a running turn", () => {
    expect(() => runProfileRename(deps({ runningProfiles: () => ["work"] }), "work", "profile-3"))
      .toThrow(/running turn/);
    expect(fs.existsSync(path.join(root, "work"))).toBe(true);
  });

  it("rolls the directory back when Keychain migration fails", () => {
    const migrateCredential = () => { throw new Error("keychain boom"); };
    expect(() => runProfileRename(deps({ migrateCredential }), "work", "profile-3")).toThrow(/keychain boom/);
    expect(fs.existsSync(path.join(root, "work"))).toBe(true);
    expect(fs.existsSync(path.join(root, "profile-3"))).toBe(false);
  });

  it("rolls the directory back when the DB update fails", () => {
    const renameSessions = () => { throw new Error("db boom"); };
    expect(() => runProfileRename(deps({ renameSessions }), "work", "profile-3")).toThrow(/db boom/);
    expect(fs.existsSync(path.join(root, "work"))).toBe(true);
  });
});

describe("handoff", () => {
  it("takes the session id and config dir from the environment", () => {
    const r = resolveHandoffInput({ CLAUDE_CODE_SESSION_ID: "sid-1", CLAUDE_CONFIG_DIR: "/custom/claude" });
    expect(r.agentSessionId).toBe("sid-1");
    expect(r.configDir).toBe("/custom/claude");
  });

  it("defaults the config dir to ~/.claude", () => {
    const r = resolveHandoffInput({ CLAUDE_CODE_SESSION_ID: "sid-1" });
    expect(r.configDir).toBe(path.join(os.homedir(), ".claude"));
  });

  it("has no session id outside Claude Code", () => {
    expect(resolveHandoffInput({}).agentSessionId).toBeNull();
  });

  it("treats an empty CLAUDE_CONFIG_DIR as unset", () => {
    const r = resolveHandoffInput({ CLAUDE_CODE_SESSION_ID: "sid-1", CLAUDE_CONFIG_DIR: "" });
    expect(r.configDir).toBe(path.join(os.homedir(), ".claude"));
  });

  // The Agent SDK reads every settings source, so `tiny live on` makes the SessionStart hook fire
  // inside the agents tiny itself spawns. TINY_SESSION_ID exists only in that environment
  it("recognizes an agent tiny spawned itself", () => {
    expect(isInsideTinyAgent({ TINY_SESSION_ID: "s-1" })).toBe(true);
    expect(isInsideTinyAgent({ TINY_SESSION_ID: "" })).toBe(false);
    expect(isInsideTinyAgent({})).toBe(false);
    expect(isInsideTinyAgent({ CLAUDE_CODE_SESSION_ID: "sid-1" })).toBe(false);
  });

  // Fallback for the hook contract: Claude Code hands hooks a JSON object on stdin
  it("reads session_id out of a hook payload, and shrugs off anything else", () => {
    expect(parseHookSessionId(JSON.stringify({
      session_id: "sid-9", cwd: "/srv/x", source: "startup", transcript_path: "/srv/x.jsonl",
    }))).toBe("sid-9");
    expect(parseHookSessionId("")).toBeNull();
    expect(parseHookSessionId("not json")).toBeNull();
    expect(parseHookSessionId("{}")).toBeNull();
    expect(parseHookSessionId(JSON.stringify({ session_id: "" }))).toBeNull();
    expect(parseHookSessionId(JSON.stringify({ session_id: 7 }))).toBeNull();
    expect(parseHookSessionId("[1,2,3]")).toBeNull();
  });

  it("creates the handoff profile once and reuses it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-hp-"));
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cd-"));
    const first = ensureHandoffProfile(root, configDir);
    expect(first).toBe("local");
    expect(readProfileConfigDir(path.join(root, "local"))).toBe(configDir);
    expect(ensureHandoffProfile(root, configDir)).toBe("local");
    expect(listProfiles(root)).toHaveLength(1);
  });

  // What `tiny doctor` reports for always-handoff. One on/off is meaningless: the mode lives in
  // each config dir's own settings.json, and every profile has one
  describe("alwaysHandoffTargets", () => {
    const prof = (name: string, dir: string, agent = "claude"): ProfileInfo => ({
      name, dir, agent, label: agent, loggedIn: true,
      capabilities: EMPTY_CAPABILITIES, defaultModel: null, defaultEffort: null, email: null,
    });

    it("puts the caller's own config dir first and reads each profile's mode", () => {
      const on = new Set(["/home/u/.tiny/profiles/profile-1"]);
      expect(alwaysHandoffTargets(
        [prof("profile-1", "/home/u/.tiny/profiles/profile-1"), prof("profile-2", "/home/u/.tiny/profiles/profile-2")],
        "/home/u/.claude",
        (dir) => on.has(dir),
      )).toEqual([
        { name: "/home/u/.claude (this shell)", on: false },
        { name: "profile-1", on: true },
        { name: "profile-2", on: false },
      ]);
    });

    // A profile can point at the very directory the shell uses (`tiny handoff` makes those).
    // Listing it twice would read as two different settings to keep in sync
    it("names the shell's dir after the profile pointing at it, once", () => {
      expect(alwaysHandoffTargets([prof("local", "/home/u/.claude")], "/home/u/.claude", () => true))
        .toEqual([{ name: "local (this shell)", on: true }]);
    });

    // Hooks are Claude Code's; codex / opencode profiles carry a storage-scan flag instead
    it("lists other agents' profiles as scan targets, with their own flag", () => {
      const targets = alwaysHandoffTargets(
        [prof("oc", "/home/u/.tiny/profiles/oc", "opencode"), prof("profile-1", "/home/u/.tiny/profiles/profile-1")],
        "/home/u/.claude",
        () => false,
        (name) => name === "oc",
      );
      expect(targets).toEqual([
        { name: "/home/u/.claude (this shell)", on: false },
        { name: "profile-1", on: false },
        { name: "oc (scan)", on: true },
      ]);
      // without a scan-flag reader (older callers) the entry still shows, defaulting to off
      const bare = alwaysHandoffTargets([prof("oc", "/x", "opencode")], "/home/u/.claude", () => false);
      expect(bare.at(-1)).toEqual({ name: "oc (scan)", on: false });
    });

    // A profile whose external config dir is gone must not take the whole report down
    it("skips a profile whose mode cannot be read", () => {
      const targets = alwaysHandoffTargets(
        [prof("broken", "/gone"), prof("profile-1", "/home/u/.tiny/profiles/profile-1")],
        "/home/u/.claude",
        (dir) => { if (dir === "/gone") throw new Error("nope"); return false; },
      );
      expect(targets.map((t) => t.name)).toEqual(["/home/u/.claude (this shell)", "profile-1"]);
    });
  });

  // `tiny live` writes hooks into ONE settings.json, so which directory that is has to be
  // unambiguous — the whole always-on mode lives there
  describe("resolveLiveConfigDir", () => {
    function profilesRoot(): string {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-live-"));
      addProfile(root, "profile-1", "claude");
      return root;
    }

    it("resolves a profile name to that profile's config dir", () => {
      const root = profilesRoot();
      expect(resolveLiveConfigDir({ profile: "profile-1" }, root, {}))
        .toBe(path.join(root, "profile-1"));
    });

    // A profile can point at an external CLAUDE_CONFIG_DIR (`tiny handoff` makes those)
    it("follows a profile that points at an external config dir", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-live-"));
      const external = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-ext-"));
      addProfile(root, "local", "claude", external);
      expect(resolveLiveConfigDir({ profile: "local" }, root, {})).toBe(external);
    });

    it("takes --config-dir as-is", () => {
      expect(resolveLiveConfigDir({ configDir: "/srv/cfg" }, profilesRoot(), {})).toBe("/srv/cfg");
    });

    it("falls back to the caller's own CLAUDE_CONFIG_DIR", () => {
      expect(resolveLiveConfigDir({}, profilesRoot(), { CLAUDE_CONFIG_DIR: "/srv/mine" }))
        .toBe("/srv/mine");
    });

    it("falls back to Claude Code's default directory when nothing says otherwise", () => {
      expect(resolveLiveConfigDir({}, profilesRoot(), {}))
        .toBe(path.join(os.homedir(), ".claude"));
    });

    // Silently letting one win would turn the mode on somewhere the user did not name
    it("refuses --profile together with --config-dir", () => {
      expect(() => resolveLiveConfigDir({ profile: "profile-1", configDir: "/srv/cfg" }, profilesRoot(), {}))
        .toThrow(/either --profile or --config-dir/);
    });

    it("names an unknown profile instead of writing hooks somewhere random", () => {
      expect(() => resolveLiveConfigDir({ profile: "nope" }, profilesRoot(), {}))
        .toThrow(/profile not found: nope/);
    });
  });

  it("makes a second profile for a different config dir", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-hp-"));
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cd-"));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cd-"));
    expect(ensureHandoffProfile(root, a)).toBe("local");
    expect(ensureHandoffProfile(root, b)).toBe("local-2");
  });
});
