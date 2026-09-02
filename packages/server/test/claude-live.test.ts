import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSessionLive, readLiveSessionIds, readLiveSessions } from "../src/claude-live.js";

const SID = "3424c289-0fc1-4ec3-a0ca-3e5f324839fa";

function writeEntry(dir: string, pid: number, body: Record<string, unknown>): void {
  fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(dir, "sessions", `${pid}.json`), JSON.stringify(body));
}

describe("claude-live", () => {
  let root: string;
  const alwaysAlive = () => true;
  const neverAlive = () => false;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-live-"));
  });

  it("is null when the registry directory does not exist", () => {
    expect(isSessionLive(root, SID, alwaysAlive)).toBeNull();
  });

  it("is true when a matching entry has a live pid", () => {
    writeEntry(root, 111, { pid: 111, sessionId: SID, peerProtocol: 1 });
    expect(isSessionLive(root, SID, alwaysAlive)).toBe(true);
  });

  it("is false when the matching entry's process is gone", () => {
    writeEntry(root, 111, { pid: 111, sessionId: SID, peerProtocol: 1 });
    expect(isSessionLive(root, SID, neverAlive)).toBe(false);
  });

  it("is false when the registry has other sessions but not this one", () => {
    writeEntry(root, 111, { pid: 111, sessionId: "other", peerProtocol: 1 });
    expect(isSessionLive(root, SID, alwaysAlive)).toBe(false);
  });

  it("is null when every entry has an unknown peerProtocol", () => {
    writeEntry(root, 111, { pid: 111, sessionId: SID, peerProtocol: 99 });
    expect(isSessionLive(root, SID, alwaysAlive)).toBeNull();
  });

  it("reads every open session id in one pass", () => {
    writeEntry(root, 111, { pid: 111, sessionId: SID, peerProtocol: 1 });
    writeEntry(root, 222, { pid: 222, sessionId: "other", peerProtocol: 1 });
    writeEntry(root, 333, { pid: 333, sessionId: "dead", peerProtocol: 1 });
    const ids = readLiveSessionIds(root, (pid) => pid !== 333);
    expect(ids).toEqual(new Set([SID, "other"]));
  });

  it("ignores unparsable entries instead of throwing", () => {
    fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(root, "sessions", "1.json"), "{broken");
    writeEntry(root, 222, { pid: 222, sessionId: SID, peerProtocol: 1 });
    expect(isSessionLive(root, SID, alwaysAlive)).toBe(true);
  });

  it("is null when the directory exists but holds no usable entry", () => {
    fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(root, "sessions", "1.json"), "{broken");
    expect(isSessionLive(root, SID, alwaysAlive)).toBeNull();
  });

  it("is null when the only matching entry is half-written (no pid yet)", () => {
    // Claude Code writes these live; an entry without a pid is a normal transient state
    writeEntry(root, 111, { sessionId: SID, peerProtocol: 1 });
    expect(isSessionLive(root, SID, alwaysAlive)).toBeNull();
  });

  it("is null when the only entry has a non-string sessionId", () => {
    writeEntry(root, 111, { pid: 111, sessionId: 42, peerProtocol: 1 });
    expect(isSessionLive(root, SID, alwaysAlive)).toBeNull();
  });

  it("is null when peerProtocol is a string rather than a number", () => {
    writeEntry(root, 111, { pid: 111, sessionId: SID, peerProtocol: "1" });
    expect(isSessionLive(root, SID, alwaysAlive)).toBeNull();
  });

  it("does not let a throwing liveness probe escape or become a false", () => {
    writeEntry(root, 111, { pid: 111, sessionId: SID, peerProtocol: 1 });
    const throwing = () => {
      throw new Error("no such process");
    };
    expect(() => isSessionLive(root, SID, throwing)).not.toThrow();
    expect(isSessionLive(root, SID, throwing)).toBeNull();
  });
});

describe("claude-live registry status", () => {
  let root: string;
  const alwaysAlive = () => true;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-live-"));
  });

  it("reads each open session's status and when it changed", () => {
    writeEntry(root, 111, { pid: 111, sessionId: SID, peerProtocol: 1, status: "busy", statusUpdatedAt: 1788178015525 });
    writeEntry(root, 222, { pid: 222, sessionId: "other", peerProtocol: 1, status: "idle", statusUpdatedAt: 1788178000000 });
    const entries = readLiveSessions(root, alwaysAlive);
    expect(entries?.get(SID)).toEqual({
      pid: 111,
      status: "busy",
      statusUpdatedAt: "2026-08-31T12:06:55.525Z",
      startedAt: null,
    });
    expect(entries?.get("other")).toEqual({
      pid: 222,
      status: "idle",
      statusUpdatedAt: "2026-08-31T12:06:40.000Z",
      startedAt: null,
    });
  });

  it("reports an unreadable or unexpected status as unknown, never as idle", () => {
    writeEntry(root, 111, { pid: 111, sessionId: SID, peerProtocol: 1 });
    writeEntry(root, 222, { pid: 222, sessionId: "other", peerProtocol: 1, status: "dancing", statusUpdatedAt: "soon" });
    const entries = readLiveSessions(root, alwaysAlive);
    expect(entries?.get(SID)).toEqual({ pid: 111, status: "unknown", statusUpdatedAt: null, startedAt: null });
    expect(entries?.get("other")).toEqual({ pid: 222, status: "unknown", statusUpdatedAt: null, startedAt: null });
  });

  it("leaves out sessions whose process is gone and agrees with readLiveSessionIds", () => {
    writeEntry(root, 111, { pid: 111, sessionId: SID, peerProtocol: 1, status: "busy" });
    writeEntry(root, 333, { pid: 333, sessionId: "dead", peerProtocol: 1, status: "busy" });
    const alive = (pid: number) => pid !== 333;
    const entries = readLiveSessions(root, alive);
    expect([...entries!.keys()]).toEqual([SID]);
    expect(readLiveSessionIds(root, alive)).toEqual(new Set([SID]));
  });

  it("is null when the registry cannot be read", () => {
    expect(readLiveSessions(root, alwaysAlive)).toBeNull();
  });

  it("carries when the process started, null when the entry does not say", () => {
    // Measured on Claude Code 2.1.258: startedAt is a ms epoch, written for every process (the SDK's too)
    writeEntry(root, 111, { pid: 111, sessionId: SID, peerProtocol: 1, startedAt: 1788357230729 });
    writeEntry(root, 222, { pid: 222, sessionId: "other", peerProtocol: 1 });
    const entries = readLiveSessions(root, alwaysAlive)!;
    expect(entries.get(SID)?.startedAt).toBe("2026-09-02T13:53:50.729Z");
    expect(entries.get("other")?.startedAt).toBeNull();
  });
});
