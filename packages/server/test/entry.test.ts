import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { tinyEntry, tinyLaunch } from "../src/entry.js";

function tmp(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tiny-entry-")));
}

describe("tinyEntry", () => {
  it("called from src/*.ts gives src/cli.ts (source)", () => {
    const e = tinyEntry({ moduleUrl: "file:///repo/packages/server/src/entry.ts", argv1: null });
    expect(e).toEqual({ file: "/repo/packages/server/src/cli.ts", isSource: true });
  });

  it("called from a dist chunk still gives dist/cli.js (dist)", () => {
    const e = tinyEntry({ moduleUrl: "file:///x/node_modules/@nasjp/tiny/dist/chunk-ABC.js", argv1: null });
    expect(e).toEqual({ file: "/x/node_modules/@nasjp/tiny/dist/cli.js", isSource: false });
  });

  it("returns the link side (the stable path) when argv[1] is a symlink to the entry's real file", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, "pkg", "dist"), { recursive: true });
    fs.mkdirSync(path.join(root, "bin"));
    const real = path.join(root, "pkg", "dist", "cli.js");
    fs.writeFileSync(real, "");
    const link = path.join(root, "bin", "tiny");
    fs.symlinkSync(path.join("..", "pkg", "dist", "cli.js"), link);
    const e = tinyEntry({ moduleUrl: pathToFileURL(path.join(root, "pkg", "dist", "chunk-1.js")).href, argv1: link });
    expect(e).toEqual({ file: link, isSource: false });
  });

  it("returns the real file when argv[1] is a different file (vitest etc.)", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, "dist"));
    fs.writeFileSync(path.join(root, "dist", "cli.js"), "");
    fs.writeFileSync(path.join(root, "other.js"), "");
    const e = tinyEntry({ moduleUrl: pathToFileURL(path.join(root, "dist", "cli.js")).href, argv1: path.join(root, "other.js") });
    expect(e.file).toBe(path.join(root, "dist", "cli.js"));
  });

  it("returns the real file without crashing even when argv[1] is a nonexistent path", () => {
    const e = tinyEntry({ moduleUrl: "file:///x/dist/cli.js", argv1: "/nope/never" });
    expect(e.file).toBe("/x/dist/cli.js");
  });
});

describe("tinyLaunch", () => {
  it("dist gives node + dist/cli.js", () => {
    expect(tinyLaunch({ file: "/opt/homebrew/bin/tiny", isSource: false }, "/opt/homebrew/bin/node")).toEqual({
      command: "/opt/homebrew/bin/node",
      args: ["/opt/homebrew/bin/tiny"],
    });
  });

  it("source gives node + tsx's cli.mjs + src/cli.ts", () => {
    const root = tmp();
    const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
    fs.mkdirSync(path.dirname(tsx), { recursive: true });
    fs.writeFileSync(tsx, "");
    const file = path.join(root, "src", "cli.ts");
    expect(tinyLaunch({ file, isSource: true }, "/n/node")).toEqual({ command: "/n/node", args: [tsx, file] });
  });

  it("source without tsx gives a clear error", () => {
    const root = tmp();
    expect(() => tinyLaunch({ file: path.join(root, "src", "cli.ts"), isSource: true }, "/n/node")).toThrow(/tsx cli not found/);
  });

  it("no arguments gives the current process's entry (source in this repo)", () => {
    const l = tinyLaunch();
    expect(l.command).toBe(process.execPath);
    expect(l.args[l.args.length - 1]).toMatch(/src\/cli\.ts$/);
  });
});
