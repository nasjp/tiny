import { beforeEach, describe, expect, it } from "vitest";
import { EMPTY_CAPABILITIES } from "../src/agents/index.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildAttachCommand, formatDeviceRow, formatProfileRow, normalizeRelayUrl, normalizeServerUrl, resolveDeviceId, resolveSessionId, runProfileRename } from "../src/cli.js";
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
