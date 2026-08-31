import { droidDriver } from "../src/agents/droid.js";
import { geminiDriver } from "../src/agents/gemini.js";
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentEnv, getDriver, listDrivers } from "../src/agents/index.js";
import { writeTinyMcpServer } from "../src/agents/codex.js";
import { cursorLoggedIn } from "../src/agents/cursor.js";
import { claudeLoggedIn, readClaudeOauthAccount } from "../src/agents/claude.js";

describe("agent drivers", () => {
  it("claude driver: label, home env, stripped env", () => {
    const d = getDriver("claude");
    expect(d.id).toBe("claude");
    expect(d.label).toBe("Claude");
    expect(d.homeEnv("/p/work")).toEqual({ CLAUDE_CONFIG_DIR: "/p/work" });
    expect(d.stripEnv).toContain("ANTHROPIC_API_KEY");
  });

  it("agentEnv drops stripEnv from the base env and adds the home env", () => {
    const env = agentEnv(getDriver("claude"), "/p/work", { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-x", HOME: "/h" });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBe("/p/work");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/h");
  });

  it("throws for an unknown agent", () => {
    expect(() => getDriver("nope")).toThrow(/unknown agent/);
  });

  it("claude capabilities: models, efforts, permission modes, features", () => {
    const caps = getDriver("claude").capabilities("/p/work");
    expect(caps.models.length).toBeGreaterThan(0);
    expect(caps.models.every((m) => m.id.startsWith("claude-"))).toBe(true);
    expect(caps.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(caps.permissionModes.map((m) => m.id)).toEqual(["default", "acceptEdits", "bypassPermissions"]);
    expect(caps.permissionModes.map((m) => m.label)).toEqual(["Ask first", "Auto-accept edits", "Bypass permissions"]);
    expect(caps.features).toMatchObject({ images: true, usage: true, questions: true, attach: true, interrupt: true });
  });

  it("claude login / attach commands", () => {
    const d = getDriver("claude");
    expect(d.login()).toEqual({ bin: "claude", args: ["/login"] });
    expect(d.attach({ agentSessionId: "abc" })).toEqual({ bin: "claude", args: ["--resume", "abc"] });
  });

  it("listDrivers includes claude", () => {
    expect(listDrivers().map((d) => d.id)).toContain("claude");
  });

  it("claude driver has adapter: claude and no launch", () => {
    const d = getDriver("claude");
    expect(d.adapter).toBe("claude");
    expect(d.launch).toBeUndefined();
  });

  describe("opencode driver", () => {
    it("points the 4 XDG dirs under the profile and does not drop API-key envs", () => {
      const d = getDriver("opencode");
      expect(d.adapter).toBe("acp");
      expect(d.launch).toEqual({ command: "opencode", args: ["acp"] });
      expect(d.homeEnv("/p/oc")).toEqual({
        XDG_DATA_HOME: "/p/oc/xdg/data",
        XDG_CONFIG_HOME: "/p/oc/xdg/config",
        XDG_CACHE_HOME: "/p/oc/xdg/cache",
        XDG_STATE_HOME: "/p/oc/xdg/state",
      });
      expect(d.stripEnv).toEqual([]);
      expect(d.login()).toEqual({ bin: "opencode", args: ["auth", "login"] });
      expect(d.attach({ agentSessionId: "ses_1" })).toEqual({ bin: "opencode", args: ["--session", "ses_1"] });
    });

    it("capabilities: empty models/efforts, ask / auto permission modes, no usage or questions", () => {
      const caps = getDriver("opencode").capabilities("/p/oc");
      expect(caps.models).toEqual([]);
      expect(caps.efforts).toEqual([]);
      expect(caps.permissionModes).toEqual([{ id: "ask", label: "Ask first" }, { id: "auto", label: "Auto-approve" }]);
      expect(caps.features).toEqual({ images: true, usage: false, questions: false, attach: true, interrupt: true });
    });

    it("isLoggedIn is true when $XDG_DATA_HOME/opencode/auth.json has at least one provider", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-oc-"));
      const d = getDriver("opencode");
      expect(d.isLoggedIn(dir)).toBe(false);
      const authDir = path.join(dir, "xdg", "data", "opencode");
      fs.mkdirSync(authDir, { recursive: true });
      fs.writeFileSync(path.join(authDir, "auth.json"), "{}");
      expect(d.isLoggedIn(dir)).toBe(false);
      fs.writeFileSync(path.join(authDir, "auth.json"), JSON.stringify({ opencode: { type: "api", key: "x" } }));
      expect(d.isLoggedIn(dir)).toBe(true);
    });

    it("prepareProfile writes an opencode.json with permission=ask and leaves an existing one alone", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-oc-"));
      const d = getDriver("opencode");
      d.prepareProfile!(dir);
      const cfgPath = path.join(dir, "xdg", "config", "opencode", "opencode.json");
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      expect(cfg.permission).toEqual({ bash: "ask", edit: "ask", webfetch: "ask" });
      fs.writeFileSync(cfgPath, JSON.stringify({ model: "keep/me" }));
      d.prepareProfile!(dir);
      expect(JSON.parse(fs.readFileSync(cfgPath, "utf8"))).toEqual({ model: "keep/me" });
    });
  });


  describe("codex driver", () => {
    it("points CODEX_HOME at the profile dir and drops API-key envs", () => {
      const d = getDriver("codex");
      expect(d.label).toBe("Codex");
      expect(d.adapter).toBe("codex");
      expect(d.launch).toEqual({ command: "codex", args: ["app-server"] });
      expect(d.homeEnv("/p/cx")).toEqual({ CODEX_HOME: "/p/cx" });
      // ANTHROPIC_API_KEY is also dropped (codex can be configured with the Anthropic provider,
      // so like other drivers this prevents API pay-as-you-go instead of the subscription)
      expect(d.stripEnv).toEqual(["OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY"]);
      expect(d.login()).toEqual({ bin: "codex", args: ["login"] });
      expect(d.attach({ agentSessionId: "thr_1" })).toEqual({ bin: "codex", args: ["resume", "thr_1"] });
    });

    it("capabilities: empty models, 4 effort levels, 3 permission modes. questions is false (unusable per measurement)", () => {
      const caps = getDriver("codex").capabilities("/p/cx");
      expect(caps.models).toEqual([]);
      expect(caps.efforts).toEqual(["low", "medium", "high", "xhigh"]);
      expect(caps.permissionModes).toEqual([
        { id: "ask", label: "Ask first" },
        { id: "auto", label: "Auto (sandboxed)" },
        { id: "bypass", label: "Bypass (full access)" },
      ]);
      expect(caps.features).toEqual({ images: true, usage: true, questions: false, attach: true, interrupt: true });
    });

    it("isLoggedIn is true when <profileDir>/auth.json exists", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cx-"));
      const d = getDriver("codex");
      expect(d.isLoggedIn(dir)).toBe(false);
      fs.writeFileSync(path.join(dir, "auth.json"), "{}");
      expect(d.isLoggedIn(dir)).toBe(true);
    });
  });

  describe("writeTinyMcpServer ([mcp_servers.tiny] in config.toml)", () => {
    const launch = {
      command: "/usr/bin/node",
      args: ["cli.js", "mcp-server"],
      env: { TINY_SERVER_URL: "http://127.0.0.1:8765", TINY_TOKEN: "tok", TINY_SESSION_ID: "s1" },
    };

    it("creates config.toml when absent (0600)", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cx-"));
      writeTinyMcpServer(dir, launch);
      const file = path.join(dir, "config.toml");
      const toml = fs.readFileSync(file, "utf8");
      expect(toml).toContain("[mcp_servers.tiny]");
      expect(toml).toContain('command = "/usr/bin/node"');
      expect(toml).toContain('args = ["cli.js", "mcp-server"]');
      expect(toml).toContain("[mcp_servers.tiny.env]");
      expect(toml).toContain('TINY_TOKEN = "tok"');
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    });

    it("replaces only the existing region, keeping surrounding user settings", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cx-"));
      writeTinyMcpServer(dir, launch);
      const file = path.join(dir, "config.toml");
      const withUser = 'model = "gpt-5.6-sol"\n' + fs.readFileSync(file, "utf8") + "[features]\nweb_search = true\n";
      fs.writeFileSync(file, withUser);
      writeTinyMcpServer(dir, { ...launch, env: { ...launch.env, TINY_SESSION_ID: "s2" } });
      const toml = fs.readFileSync(file, "utf8");
      expect(toml.startsWith('model = "gpt-5.6-sol"\n')).toBe(true);
      expect(toml).toContain("[features]\nweb_search = true");
      expect(toml).toContain('TINY_SESSION_ID = "s2"');
      expect(toml).not.toContain('TINY_SESSION_ID = "s1"');
      expect(toml.match(/\[mcp_servers\.tiny\]/g)).toHaveLength(1);
    });

    it("removes the region on null and creates nothing when the file is absent", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cx-"));
      writeTinyMcpServer(dir, null);
      expect(fs.existsSync(path.join(dir, "config.toml"))).toBe(false);
      writeTinyMcpServer(dir, launch);
      fs.appendFileSync(path.join(dir, "config.toml"), '[features]\nweb_search = true\n');
      writeTinyMcpServer(dir, null);
      const toml = fs.readFileSync(path.join(dir, "config.toml"), "utf8");
      expect(toml).not.toContain("mcp_servers");
      expect(toml).toContain("[features]");
    });

    it("rewrites a 0644 config.toml (fresh from codex itself) to 0600 while preserving its contents", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cx-"));
      const file = path.join(dir, "config.toml");
      fs.writeFileSync(file, 'model = "gpt-5.6-sol"\n', { mode: 0o644 });
      expect(fs.statSync(file).mode & 0o777).toBe(0o644);
      writeTinyMcpServer(dir, launch);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      const toml = fs.readFileSync(file, "utf8");
      expect(toml.startsWith('model = "gpt-5.6-sol"\n')).toBe(true);
      expect(toml).toContain("[mcp_servers.tiny]");
    });

    it("cleans up the temp file and rethrows when rename fails", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cx-"));
      const spy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
        throw new Error("boom");
      });
      try {
        expect(() => writeTinyMcpServer(dir, launch)).toThrow("boom");
      } finally {
        spy.mockRestore();
      }
      const leftover = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
      expect(leftover).toEqual([]);
    });

    it("TOML escaping (backslashes and double quotes)", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cx-"));
      writeTinyMcpServer(dir, { command: 'C:\\node "x"', args: ['a"b'], env: { TINY_TOKEN: 'q"\\z' } });
      const toml = fs.readFileSync(path.join(dir, "config.toml"), "utf8");
      expect(toml).toContain('command = "C:\\\\node \\"x\\""');
      expect(toml).toContain('args = ["a\\"b"]');
      expect(toml).toContain('TINY_TOKEN = "q\\"\\\\z"');
    });
  });

  describe("cursor driver (ACP; measured 2026-08-30: session/new, permission, image, cancel, load OK, no resume)", () => {
    it("has an empty homeEnv (shares the real HOME; the Keychain rules out profile isolation) and drops CURSOR_API_KEY", () => {
      const d = getDriver("cursor");
      expect(d.label).toBe("Cursor");
      expect(d.bin).toBe("cursor-agent");
      expect(d.adapter).toBe("acp");
      expect(d.launch).toEqual({ command: "cursor-agent", args: ["acp"] });
      expect(d.homeEnv("/p/cur")).toEqual({});
      expect(d.stripEnv).toEqual(["CURSOR_API_KEY"]);
      expect(d.login()).toEqual({ bin: "cursor-agent", args: ["login"] });
      expect(d.attach({ agentSessionId: "sess_1" })).toEqual({ bin: "cursor-agent", args: ["--resume", "sess_1"] });
      expect(d.authMethodId).toBe("cursor_login");
    });

    it("capabilities: empty models/efforts, ask / auto permission modes, images supported, no usage/questions", () => {
      const caps = getDriver("cursor").capabilities("/p/cur");
      expect(caps.models).toEqual([]);
      expect(caps.efforts).toEqual([]);
      expect(caps.permissionModes).toEqual([{ id: "ask", label: "Ask first" }, { id: "auto", label: "Auto-approve" }]);
      expect(caps.features).toEqual({ images: true, usage: false, questions: false, attach: true, interrupt: true });
    });

    it("cursorLoggedIn(homeDir) checks for the authInfo key in <homeDir>/.cursor/cli-config.json", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cur-"));
      expect(cursorLoggedIn(dir)).toBe(false);
      const cursorDir = path.join(dir, ".cursor");
      fs.mkdirSync(cursorDir, { recursive: true });
      fs.writeFileSync(path.join(cursorDir, "cli-config.json"), JSON.stringify({ version: 1 }));
      expect(cursorLoggedIn(dir)).toBe(false);
      fs.writeFileSync(
        path.join(cursorDir, "cli-config.json"),
        JSON.stringify({ authInfo: { email: "a@example.com" } }),
      );
      expect(cursorLoggedIn(dir)).toBe(true);
    });

    it("isLoggedIn ignores profileDir and delegates to cursorLoggedIn on os.homedir()", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cur-home-"));
      const spy = vi.spyOn(os, "homedir").mockReturnValue(dir);
      try {
        const d = getDriver("cursor");
        expect(d.isLoggedIn("/some/unrelated/profile-dir")).toBe(false);
        fs.mkdirSync(path.join(dir, ".cursor"), { recursive: true });
        fs.writeFileSync(path.join(dir, ".cursor", "cli-config.json"), JSON.stringify({ authInfo: { email: "a@example.com" } }));
        expect(d.isLoggedIn("/some/unrelated/profile-dir")).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("droid driver (ACP; measured: never reached session/new = tool_call etc. unmeasured)", () => {
    it("points FACTORY_HOME_OVERRIDE at the profile dir and drops FACTORY_API_KEY", () => {
      const d = droidDriver;
      expect(d.label).toBe("Droid");
      expect(d.bin).toBe("droid");
      expect(d.adapter).toBe("acp");
      expect(d.launch).toEqual({ command: "droid", args: ["exec", "--output-format", "acp"] });
      expect(d.homeEnv("/p/dr")).toEqual({ FACTORY_HOME_OVERRIDE: "/p/dr" });
      expect(d.stripEnv).toEqual(["FACTORY_API_KEY"]);
      expect(d.login()).toEqual({ bin: "droid", args: [] });
      expect(d.attach({ agentSessionId: "sess_1" })).toEqual({ bin: "droid", args: ["--resume", "sess_1"] });
      expect(d.authMethodId).toBe("device-pairing");
    });

    it("capabilities: empty models/efforts, ask / auto permission modes, images supported, no usage/questions", () => {
      const caps = droidDriver.capabilities("/p/dr");
      expect(caps.models).toEqual([]);
      expect(caps.efforts).toEqual([]);
      expect(caps.permissionModes).toEqual([{ id: "ask", label: "Ask first" }, { id: "auto", label: "Auto-approve" }]);
      expect(caps.features).toEqual({ images: true, usage: false, questions: false, attach: true, interrupt: true });
    });

    it("isLoggedIn checks for <FACTORY_HOME_OVERRIDE>/.factory/auth.json", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-dr-"));
      const d = droidDriver;
      expect(d.isLoggedIn(dir)).toBe(false);
      const factoryDir = path.join(dir, ".factory");
      fs.mkdirSync(factoryDir, { recursive: true });
      fs.writeFileSync(path.join(factoryDir, "auth.json"), "{}");
      expect(d.isLoggedIn(dir)).toBe(true);
    });
  });

  describe("gemini driver (ACP; measured: never reached session/new = tool_call etc. unmeasured)", () => {
    it("points HOME at the profile dir and drops API-key/Vertex envs", () => {
      const d = geminiDriver;
      expect(d.label).toBe("Gemini CLI");
      expect(d.bin).toBe("gemini");
      expect(d.adapter).toBe("acp");
      expect(d.launch).toEqual({ command: "gemini", args: ["--acp"] });
      expect(d.homeEnv("/p/ge")).toEqual({ HOME: "/p/ge" });
      expect(d.stripEnv).toEqual(["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"]);
      expect(d.login()).toEqual({ bin: "gemini", args: [] });
      expect(d.attach({ agentSessionId: "sess_1" })).toEqual({ bin: "gemini", args: ["--resume", "sess_1"] });
    });

    it("capabilities: empty models/efforts, ask / auto permission modes, images supported, no usage/questions", () => {
      const caps = geminiDriver.capabilities("/p/ge");
      expect(caps.models).toEqual([]);
      expect(caps.efforts).toEqual([]);
      expect(caps.permissionModes).toEqual([{ id: "ask", label: "Ask first" }, { id: "auto", label: "Auto-approve" }]);
      expect(caps.features).toEqual({ images: true, usage: false, questions: false, attach: true, interrupt: true });
    });

    it("isLoggedIn checks for <HOME>/.gemini/oauth_creds.json", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-ge-"));
      const d = geminiDriver;
      expect(d.isLoggedIn(dir)).toBe(false);
      const geminiDir = path.join(dir, ".gemini");
      fs.mkdirSync(geminiDir, { recursive: true });
      fs.writeFileSync(path.join(geminiDir, "oauth_creds.json"), "{}");
      expect(d.isLoggedIn(dir)).toBe(true);
    });
  });

  it("listDrivers includes claude / opencode / codex / cursor and leaves droid / gemini unregistered", () => {
    expect(listDrivers().map((d) => d.id)).toEqual(
      expect.arrayContaining(["claude", "opencode", "codex", "cursor"]),
    );
  });
});

// Claude Code resolves its config file asymmetrically: with CLAUDE_CONFIG_DIR unset it reads
// ~/.claude.json (home root), with it set to $X it reads $X/.claude.json. So naming the default
// data directory explicitly is NOT a no-op — it points the lookup at ~/.claude/.claude.json,
// which a normal installation does not have, and every turn fails with
// "Claude configuration file not found". `tiny handoff` writes exactly that config dir
describe("claude default config dir", () => {
  function withHome<T>(fn: (home: string) => T): T {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tiny-home-")));
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      return fn(home);
    } finally {
      if (prev === undefined) delete process.env.HOME;
      else process.env.HOME = prev;
    }
  }

  it("homeEnv marks CLAUDE_CONFIG_DIR for removal when the dir is the default one", () => {
    withHome((home) => {
      expect(getDriver("claude").homeEnv(path.join(home, ".claude"))).toStrictEqual({ CLAUDE_CONFIG_DIR: undefined });
    });
  });

  it("agentEnv leaves no CLAUDE_CONFIG_DIR key at all for the default dir", () => {
    withHome((home) => {
      const env = agentEnv(getDriver("claude"), path.join(home, ".claude"), {
        PATH: "/usr/bin",
        CLAUDE_CONFIG_DIR: "/srv/stale",
      });
      expect(Object.hasOwn(env, "CLAUDE_CONFIG_DIR")).toBe(false);
      expect(env.PATH).toBe("/usr/bin");
    });
  });

  it("a trailing slash does not defeat the match", () => {
    withHome((home) => {
      const env = agentEnv(getDriver("claude"), path.join(home, ".claude") + "/", { PATH: "/usr/bin" });
      expect(Object.hasOwn(env, "CLAUDE_CONFIG_DIR")).toBe(false);
    });
  });

  // Same asymmetry on the read side: for the default dir the account info lives in ~/.claude.json,
  // not in <dir>/.claude.json, so a handoff profile would otherwise be reported as logged out
  it("login detection reads ~/.claude.json for the default dir", () => {
    withHome((home) => {
      const dir = path.join(home, ".claude");
      fs.mkdirSync(dir, { recursive: true });
      expect(claudeLoggedIn(dir)).toBe(false);
      fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "a@b.c" } }));
      expect(claudeLoggedIn(dir)).toBe(true);
      expect(readClaudeOauthAccount(dir)).toEqual({ emailAddress: "a@b.c" });
    });
  });

  it("an accountless <default dir>/.claude.json does not mask the real one", () => {
    withHome((home) => {
      const dir = path.join(home, ".claude");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ mcpServers: {} }));
      fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "a@b.c" } }));
      expect(claudeLoggedIn(dir)).toBe(true);
    });
  });

  it("any other config dir keeps reading <dir>/.claude.json", () => {
    withHome((home) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cfg-"));
      fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "a@b.c" } }));
      expect(claudeLoggedIn(dir)).toBe(false);
      fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "d@e.f" } }));
      expect(readClaudeOauthAccount(dir)).toEqual({ emailAddress: "d@e.f" });
    });
  });

  it("any other config dir still sets CLAUDE_CONFIG_DIR", () => {
    withHome(() => {
      const env = agentEnv(getDriver("claude"), "/srv/profiles/work", { PATH: "/usr/bin" });
      expect(env.CLAUDE_CONFIG_DIR).toBe("/srv/profiles/work");
    });
  });
});
