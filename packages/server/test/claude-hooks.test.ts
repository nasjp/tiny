import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildHookCommand, readLiveMode, setLiveMode } from "../src/claude-hooks.js";

const CMD = "/usr/local/bin/tiny handoff --auto";

describe("claude-hooks", () => {
  let dir: string;
  const settings = () => path.join(dir, "settings.json");
  const read = () => JSON.parse(fs.readFileSync(settings(), "utf8")) as Record<string, any>;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-hooks-"));
  });

  it("is off when there is no settings.json", () => {
    expect(readLiveMode(dir)).toBe(false);
  });

  it("turns on by adding SessionStart and SessionEnd hooks", () => {
    setLiveMode(dir, true, CMD);
    expect(readLiveMode(dir)).toBe(true);
    const s = read();
    expect(s.hooks.SessionStart[0].hooks[0].command).toBe(CMD);
    expect(s.hooks.SessionEnd[0].hooks[0].command).toBe(`${CMD} --ended`);
  });

  it("keeps unrelated settings and unrelated hooks intact", () => {
    fs.writeFileSync(settings(), JSON.stringify({
      model: "claude-opus-5",
      hooks: {
        Notification: [{ matcher: "", hooks: [{ type: "command", command: "say hi" }] }],
        SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "echo other" }] }],
      },
    }));
    setLiveMode(dir, true, CMD);
    const s = read();
    expect(s.model).toBe("claude-opus-5");
    expect(s.hooks.Notification[0].hooks[0].command).toBe("say hi");
    const cmds = s.hooks.SessionStart.flatMap((e: any) => e.hooks.map((h: any) => h.command));
    expect(cmds).toContain("echo other");
    expect(cmds).toContain(CMD);
  });

  it("turning on twice does not duplicate the hook", () => {
    setLiveMode(dir, true, CMD);
    setLiveMode(dir, true, CMD);
    const s = read();
    const cmds = s.hooks.SessionStart.flatMap((e: any) => e.hooks.map((h: any) => h.command));
    expect(cmds.filter((c: string) => c === CMD)).toHaveLength(1);
  });

  it("turning off removes only tiny's hooks", () => {
    fs.writeFileSync(settings(), JSON.stringify({
      hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "echo other" }] }] },
    }));
    setLiveMode(dir, true, CMD);
    setLiveMode(dir, false, CMD);
    expect(readLiveMode(dir)).toBe(false);
    const s = read();
    const cmds = s.hooks.SessionStart.flatMap((e: any) => e.hooks.map((h: any) => h.command));
    expect(cmds).toEqual(["echo other"]);
  });

  it("recognises a hook installed under a different tiny path", () => {
    fs.writeFileSync(settings(), JSON.stringify({
      hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "/opt/tiny handoff --auto" }] }] },
    }));
    expect(readLiveMode(dir)).toBe(true);
  });

  it("builds an absolute hook command and quotes paths with spaces", () => {
    expect(buildHookCommand("/usr/local/bin/node", ["/opt/tiny/dist/cli.js"]))
      .toBe("/usr/local/bin/node /opt/tiny/dist/cli.js handoff --auto");
    expect(buildHookCommand("/usr/bin/node", ["/Users/a/My Apps/cli.js"]))
      .toBe("/usr/bin/node '/Users/a/My Apps/cli.js' handoff --auto");
  });

  it("claims both the SessionStart and SessionEnd commands it generates", () => {
    setLiveMode(dir, true, CMD);
    // both hooks must be recognized as ours, or `off` would leave one behind
    setLiveMode(dir, false, CMD);
    const s = read();
    expect(s.hooks).toBeUndefined();
  });

  it("does not claim an unrelated hook that merely mentions the command", () => {
    fs.writeFileSync(settings(), JSON.stringify({
      hooks: {
        SessionStart: [
          { matcher: "", hooks: [{ type: "command", command: 'echo "remember to run handoff --auto later"' }] },
        ],
      },
    }));
    setLiveMode(dir, true, CMD);
    setLiveMode(dir, false, CMD);
    const cmds = read().hooks.SessionStart.flatMap((e: any) => e.hooks.map((h: any) => h.command));
    // the user's own hook must survive a full round trip
    expect(cmds).toEqual(['echo "remember to run handoff --auto later"']);
  });

  it("refuses to clobber a broken settings.json", () => {
    fs.writeFileSync(settings(), "{not json");
    expect(() => setLiveMode(dir, true, CMD)).toThrow(/could not be parsed/);
    expect(fs.readFileSync(settings(), "utf8")).toBe("{not json");
  });
});
