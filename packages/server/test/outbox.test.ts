import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db.js";
import { createStores } from "../src/stores.js";
import { FileOutbox } from "../src/outbox.js";

describe("FileOutbox", () => {
  let dir: string;
  let outbox: FileOutbox;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-outbox-"));
    outbox = new FileOutbox(dir, createStores(openDb(":memory:")).files);
  });

  it("save copies and records in the DB, readable even after the source is deleted", () => {
    const src = path.join(dir, "report.html");
    fs.writeFileSync(src, "<h1>hi</h1>");
    const rec = outbox.save("s1", src, "report");
    expect(rec.mime).toBe("text/html");
    expect(rec.caption).toBe("report");
    fs.rmSync(src);
    const got = outbox.get(rec.id)!;
    expect(fs.readFileSync(got.storedPath, "utf8")).toBe("<h1>hi</h1>");
  });

  it("looks up MIME from the extension (unknown is octet-stream)", () => {
    for (const [ext, mime] of [
      ["png", "image/png"], ["pdf", "application/pdf"], ["md", "text/markdown"], ["xyz", "application/octet-stream"],
    ] as const) {
      const src = path.join(dir, `f.${ext}`);
      fs.writeFileSync(src, "x");
      expect(outbox.save("s1", src).mime).toBe(mime);
    }
  });

  it("throws on a nonexistent path", () => {
    expect(() => outbox.save("s1", path.join(dir, "nope.txt"))).toThrow();
  });
});
