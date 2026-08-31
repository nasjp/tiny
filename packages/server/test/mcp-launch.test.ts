import { describe, expect, it } from "vitest";
import { makeMcpLaunch } from "../src/mcp-launch.js";

describe("makeMcpLaunch", () => {
  it("puts the session id and per-turn token in env (never the CLI token)", () => {
    const launch = makeMcpLaunch({ serverUrl: () => "http://127.0.0.1:7777" });
    const l = launch("sess-1", "tok-abc");
    expect(l.env).toEqual({ TINY_SERVER_URL: "http://127.0.0.1:7777", TINY_TOKEN: "tok-abc", TINY_SESSION_ID: "sess-1" });
    expect(l.args[l.args.length - 1]).toBe("mcp-server");
  });

  it("appends mcp-server after a passed launch (used by the dist daemon)", () => {
    const launch = makeMcpLaunch({ serverUrl: () => "http://127.0.0.1:7777", launch: { command: "/n/node", args: ["/opt/homebrew/bin/tiny"] } });
    expect(launch("s", "t").command).toBe("/n/node");
    expect(launch("s", "t").args).toEqual(["/opt/homebrew/bin/tiny", "mcp-server"]);
  });
});
