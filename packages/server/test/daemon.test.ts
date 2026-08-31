import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DAEMON_LABEL,
  daemonPathEnv,
  installDaemon,
  loginShellEnv,
  loginShellPath,
  parsePlistPathEnv,
  parsePlistProgramArguments,
  plistPath,
  readInstalledDaemon,
  renderPlist,
} from "../src/daemon.js";

describe("renderPlist", () => {
  it("lists ProgramArguments in order and carries RunAtLoad / KeepAlive / logs / PATH", () => {
    const xml = renderPlist({
      label: DAEMON_LABEL,
      programArguments: ["/opt/homebrew/bin/node", "/opt/homebrew/bin/tiny", "serve"],
      logDir: "/Users/u/.tiny",
      pathEnv: "/opt/homebrew/bin:/usr/bin:/bin",
    });
    expect(xml).toContain("<key>Label</key><string>com.tanirell.tinyd</string>");
    expect(xml.indexOf("/opt/homebrew/bin/node")).toBeLessThan(xml.indexOf("/opt/homebrew/bin/tiny"));
    expect(xml.indexOf("/opt/homebrew/bin/tiny")).toBeLessThan(xml.indexOf("<string>serve</string>"));
    expect(xml).toContain("<key>RunAtLoad</key><true/>");
    expect(xml).toContain("<key>KeepAlive</key><true/>");
    expect(xml).toContain("/Users/u/.tiny/tinyd.out.log");
    expect(xml).toContain("<key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string>");
    expect(xml).not.toContain("tsx");
  });

  it("escapes XML special characters and round-trips through parse", () => {
    const args = ["/Users/a&b/bin/node", "/repo/<weird>/cli.js", "serve"];
    const xml = renderPlist({ label: DAEMON_LABEL, programArguments: args, logDir: "/Users/a&b/.tiny", pathEnv: "/usr/bin:/bin&<x>" });
    expect(xml).toContain("/Users/a&amp;b/bin/node");
    expect(xml).not.toContain("<weird>");
    expect(parsePlistProgramArguments(xml)).toEqual(args);
    expect(parsePlistPathEnv(xml)).toBe("/usr/bin:/bin&<x>");
  });

  it("returns empty for XML without ProgramArguments / PATH", () => {
    expect(parsePlistProgramArguments("<plist></plist>")).toEqual([]);
    expect(parsePlistPathEnv("<plist></plist>")).toBe("");
  });
});

describe("daemonPathEnv", () => {
  const isDir = (d: string) => !d.includes("missing");

  it("orders node dir → agent dirs → login-shell PATH → standard dirs, keeping only existing ones without duplicates", () => {
    const p = daemonPathEnv({
      execPath: "/Users/u/.local/share/mise/installs/node/22.12.0/bin/node",
      binDirs: ["/Users/u/.bun/bin", "/opt/homebrew/bin", "/Users/u/.local/bin"],
      shellPath: "/Users/u/missing-old-repo/node_modules/.bin:/opt/homebrew/bin:/Users/u/Library/pnpm:/usr/bin",
      isDir,
    });
    expect(p.split(":")).toEqual([
      "/Users/u/.local/share/mise/installs/node/22.12.0/bin",
      "/Users/u/.bun/bin",
      "/opt/homebrew/bin",
      "/Users/u/.local/bin",
      "/Users/u/Library/pnpm",
      "/usr/bin",
      "/usr/local/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ]);
  });

  it("still includes node and standard dirs when the login-shell PATH is unavailable", () => {
    const p = daemonPathEnv({ execPath: "/opt/homebrew/bin/node", binDirs: [], shellPath: null, isDir });
    expect(p.split(":")[0]).toBe("/opt/homebrew/bin");
    expect(p.split(":")).toContain("/usr/bin");
    expect(new Set(p.split(":")).size).toBe(p.split(":").length);
  });

  it("never bakes in relative-path entries (excludes . or bin mixed into the login-shell PATH)", () => {
    const p = daemonPathEnv({
      execPath: "/opt/homebrew/bin/node",
      binDirs: [],
      shellPath: ".:bin:/usr/bin",
      isDir: () => true,
    });
    const dirs = p.split(":");
    expect(dirs).toContain("/usr/bin");
    expect(dirs).not.toContain(".");
    expect(dirs).not.toContain("bin");
  });
});

describe("loginShellPath", () => {
  it("returns the shell's last line as PATH (uses only the last line even when rc prints extra lines)", () => {
    const calls: string[][] = [];
    const run = (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return "Welcome!\n/opt/homebrew/bin:/usr/bin\n";
    };
    expect(loginShellPath("/bin/zsh", run)).toBe("/opt/homebrew/bin:/usr/bin");
    expect(calls[0]?.[0]).toBe("/bin/zsh");
    expect(calls[0]?.[1]).toBe("-lic");
  });

  it("null on failure or empty output", () => {
    expect(loginShellPath("/bin/zsh", () => { throw new Error("boom"); })).toBeNull();
    expect(loginShellPath("/bin/zsh", () => "\n")).toBeNull();
  });

  it("space-separated output (fish's $PATH) is not a valid PATH, so null", () => {
    expect(loginShellPath("/usr/bin/fish", () => "/opt/homebrew/bin /usr/bin\n")).toBeNull();
    // Colon-separated with a dir containing spaces is still a valid PATH
    expect(loginShellPath("/bin/zsh", () => "/Applications/Some App/bin:/usr/bin\n")).toBe("/Applications/Some App/bin:/usr/bin");
  });
});

describe("loginShellEnv", () => {
  it("inherits neither the parent env's PATH nor secrets; passes only the minimal env", () => {
    const env = loginShellEnv({
      PATH: "/weird/npx/bin:/usr/bin",
      HOME: "/Users/x",
      USER: "x",
      SHELL: "/bin/zsh",
      TERM: "xterm-256color",
      ANTHROPIC_API_KEY: "sk-should-not-leak",
    });
    expect(env.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
    expect(env.HOME).toBe("/Users/x");
    expect(env.USER).toBe("x");
    expect(env.SHELL).toBe("/bin/zsh");
    expect(env.TERM).toBe("xterm-256color");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(Object.values(env).join(":")).not.toContain("/weird/npx/bin");
  });

  it("does not add keys missing from the source env", () => {
    expect(loginShellEnv({ HOME: "/Users/x" })).toEqual({ HOME: "/Users/x", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" });
  });
});

describe("installDaemon / readInstalledDaemon", () => {
  it("writes the plist, does bootout → bootstrap, and reads it back", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-daemon-"));
    const calls: string[][] = [];
    const msg = installDaemon({
      home,
      logDir: path.join(home, ".tiny"),
      launch: { command: "/opt/homebrew/bin/node", args: ["/opt/homebrew/bin/tiny"] },
      binDirs: ["/opt/homebrew/bin"],
      shellPath: null,
      uid: 501,
      launchctl: (args) => calls.push(args),
      sleepMs: () => {},
    });
    const file = plistPath(home);
    expect(file).toBe(path.join(home, "Library", "LaunchAgents", `${DAEMON_LABEL}.plist`));
    expect(fs.existsSync(file)).toBe(true);
    expect(calls).toEqual([
      ["bootout", `gui/501/${DAEMON_LABEL}`],
      ["bootstrap", "gui/501", file],
    ]);
    expect(msg).toContain(file);
    expect(msg).toContain("/opt/homebrew/bin/node /opt/homebrew/bin/tiny serve");
    const installed = readInstalledDaemon(home);
    expect(installed?.programArguments).toEqual(["/opt/homebrew/bin/node", "/opt/homebrew/bin/tiny", "serve"]);
    expect(installed?.pathEnv.split(":")[0]).toBe("/opt/homebrew/bin");
    expect(fs.existsSync(path.join(home, ".tiny"))).toBe(true);
  });

  it("ignores a bootout failure (not registered) and still bootstraps", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-daemon-"));
    const calls: string[][] = [];
    installDaemon({
      home, logDir: path.join(home, ".tiny"),
      launch: { command: "/n/node", args: ["/x/cli.js"] }, binDirs: [], shellPath: null, uid: 501,
      launchctl: (args) => { calls.push(args); if (args[0] === "bootout") throw new Error("not loaded"); },
      sleepMs: () => {},
    });
    expect(calls.map((c) => c[0])).toEqual(["bootout", "bootstrap"]);
  });

  it("null when there is no plist", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-daemon-"));
    expect(readInstalledDaemon(home)).toBeNull();
  });

  it("sleeps and retries transient bootstrap failures, eventually succeeding", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-daemon-"));
    const calls: string[][] = [];
    const sleeps: number[] = [];
    let bootstrapAttempts = 0;
    installDaemon({
      home, logDir: path.join(home, ".tiny"),
      launch: { command: "/n/node", args: ["/x/cli.js"] }, binDirs: [], shellPath: null, uid: 501,
      launchctl: (args) => {
        calls.push(args);
        if (args[0] === "bootstrap") {
          bootstrapAttempts++;
          if (bootstrapAttempts < 3) throw new Error("Bootstrap failed: 5: Input/output error");
        }
      },
      sleepMs: (ms) => sleeps.push(ms),
    });
    expect(calls.map((c) => c[0])).toEqual(["bootout", "bootstrap", "bootstrap", "bootstrap"]);
    expect(sleeps).toEqual([500, 500]);
  });

  it("when bootstrap always fails, tries 10 times then throws with guidance", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-daemon-"));
    const calls: string[][] = [];
    const file = plistPath(home);
    expect(() =>
      installDaemon({
        home, logDir: path.join(home, ".tiny"),
        launch: { command: "/n/node", args: ["/x/cli.js"] }, binDirs: [], shellPath: null, uid: 501,
        launchctl: (args) => {
          calls.push(args);
          if (args[0] === "bootstrap") throw new Error("Bootstrap failed: 5: Input/output error");
        },
        sleepMs: () => {},
      }),
    ).toThrowError(/launchctl bootstrap/);
    expect(() =>
      installDaemon({
        home, logDir: path.join(home, ".tiny"),
        launch: { command: "/n/node", args: ["/x/cli.js"] }, binDirs: [], shellPath: null, uid: 501,
        launchctl: (args) => {
          if (args[0] === "bootstrap") throw new Error("Bootstrap failed: 5: Input/output error");
        },
        sleepMs: () => {},
      }),
    ).toThrowError(/tiny daemon uninstall/);
    expect(calls.filter((c) => c[0] === "bootstrap")).toHaveLength(10);
    expect(calls[0]).toEqual(["bootout", `gui/501/${DAEMON_LABEL}`]);
    expect(file).toBe(plistPath(home));
  });

  it("when bootstrap always fails, says that tinyd is not running", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-daemon-"));
    expect(() =>
      installDaemon({
        home, logDir: path.join(home, ".tiny"),
        launch: { command: "/n/node", args: ["/x/cli.js"] }, binDirs: [], shellPath: null, uid: 501,
        launchctl: (args) => {
          if (args[0] === "bootstrap") throw new Error("Bootstrap failed: 5: Input/output error");
        },
        sleepMs: () => {},
      }),
    ).toThrowError(/tinyd is not running/);
  });
});
