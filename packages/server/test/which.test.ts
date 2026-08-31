import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findOnPath, isOnPath } from "../src/which.js";

function setup(): { a: string; b: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-which-"));
  const a = path.join(root, "a");
  const b = path.join(root, "b");
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  fs.writeFileSync(path.join(a, "codex"), "#!/bin/sh\n", { mode: 0o755 });
  fs.writeFileSync(path.join(b, "codex"), "#!/bin/sh\n", { mode: 0o755 });
  fs.writeFileSync(path.join(b, "notexec"), "", { mode: 0o644 });
  fs.mkdirSync(path.join(b, "dirname-like-bin"), { mode: 0o755 });
  return { a, b };
}

describe("findOnPath", () => {
  it("returns the absolute path of the first executable found in PATH order", () => {
    const { a, b } = setup();
    expect(findOnPath("codex", `${b}:${a}`)).toBe(path.join(b, "codex"));
    expect(findOnPath("codex", `${a}:${b}`)).toBe(path.join(a, "codex"));
  });

  it("ignores non-executable files and directories", () => {
    const { b } = setup();
    expect(findOnPath("notexec", b)).toBeNull();
    expect(findOnPath("dirname-like-bin", b)).toBeNull();
  });

  it("null when not found; does not crash on an empty PATH", () => {
    const { a } = setup();
    expect(findOnPath("nope", a)).toBeNull();
    expect(findOnPath("codex", "")).toBeNull();
    expect(findOnPath("codex", undefined)).toBe(findOnPath("codex", process.env.PATH));
  });

  it("isOnPath returns only a boolean", () => {
    const { a } = setup();
    expect(isOnPath("codex", a)).toBe(true);
    expect(isOnPath("nope", a)).toBe(false);
  });
});
