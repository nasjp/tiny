import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { ensureDirs, tinyPaths } from "../src/config.js";

describe("tinyPaths", () => {
  it("uses ~/.tiny when TINY_HOME is unset", () => {
    const p = tinyPaths({});
    expect(p.home).toBe(path.join(os.homedir(), ".tiny"));
    expect(p.dbFile).toBe(path.join(p.home, "tiny.db"));
    expect(p.profilesDir).toBe(path.join(p.home, "profiles"));
    expect(p.outboxDir).toBe(path.join(p.home, "outbox"));
    expect(p.secretFile).toBe(path.join(p.home, "secret"));
    expect(p.port).toBe(7777);
  });

  it("can be overridden via TINY_HOME and TINY_PORT", () => {
    const p = tinyPaths({ TINY_HOME: "/tmp/x", TINY_PORT: "8888" });
    expect(p.home).toBe("/tmp/x");
    expect(p.port).toBe(8888);
  });

  it("falls back to 7777 when TINY_PORT is invalid", () => {
    expect(tinyPaths({ TINY_PORT: "abc" }).port).toBe(7777);
  });

  it("ensureDirs creates home/profiles/outbox", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-test-"));
    const p = tinyPaths({ TINY_HOME: path.join(home, "root") });
    ensureDirs(p);
    expect(fs.existsSync(p.profilesDir)).toBe(true);
    expect(fs.existsSync(p.outboxDir)).toBe(true);
  });
});
