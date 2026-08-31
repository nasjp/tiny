import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import {
  encodePeerFrames,
  PEER_NOTE,
  readCliMode,
  readPeerStatus,
  readPeerToken,
  resolvePeerTarget,
  sendPeerMessage,
  summarizePeerInboxes,
  wrapForPeer,
} from "../src/claude-peer.js";

const SID = "e034bdbb-9071-4cab-b9cb-751134e278cc";
const alwaysAlive = () => true;
const neverAlive = () => false;

function writeEntry(dir: string, pid: number, body: Record<string, unknown>): void {
  fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(dir, "sessions", `${pid}.json`), JSON.stringify(body));
}

function entry(pid: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pid, sessionId: SID, peerProtocol: 1, messagingSocketPath: `/tmp/cc-socks/${pid}.sock`,
    status: "idle", ...over,
  };
}

describe("claude-peer: resolvePeerTarget", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-peer-"));
  });

  it("returns the live process holding the session, with the socket path the registry advertises", () => {
    writeEntry(root, 111, entry(111, { messagingSocketPath: "/run/user/501/cc-socks/111.sock" }));
    expect(resolvePeerTarget(root, SID, alwaysAlive)).toEqual({ pid: 111, sockPath: "/run/user/501/cc-socks/111.sock" });
  });

  it("is null without a registry directory", () => {
    expect(resolvePeerTarget(root, SID, alwaysAlive)).toBeNull();
  });

  it("skips entries for other sessions, dead processes, unknown protocols, and entries without a socket", () => {
    writeEntry(root, 1, entry(1, { sessionId: "other" }));
    writeEntry(root, 2, entry(2)); // dead (see alive below)
    writeEntry(root, 3, entry(3, { peerProtocol: 2 }));
    writeEntry(root, 4, entry(4, { messagingSocketPath: undefined }));
    expect(resolvePeerTarget(root, SID, (pid) => pid !== 2)).toBeNull();
    writeEntry(root, 5, entry(5));
    expect(resolvePeerTarget(root, SID, (pid) => pid !== 2)).toEqual({ pid: 5, sockPath: "/tmp/cc-socks/5.sock" });
  });

  it("ignores a half-written entry instead of throwing", () => {
    fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(root, "sessions", "9.json"), "{broken");
    writeEntry(root, 10, entry(10));
    expect(resolvePeerTarget(root, SID, alwaysAlive)?.pid).toBe(10);
  });
});

describe("claude-peer: readPeerStatus", () => {
  let root: string;
  const target = { pid: 111, sockPath: "/tmp/cc-socks/111.sock" };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-peer-"));
  });

  it("reads busy / idle / waiting with waitingFor", () => {
    writeEntry(root, 111, entry(111, { status: "busy" }));
    expect(readPeerStatus(root, target, alwaysAlive)).toEqual({ status: "busy", waitingFor: null });
    writeEntry(root, 111, entry(111, { status: "waiting", waitingFor: "permission prompt" }));
    expect(readPeerStatus(root, target, alwaysAlive)).toEqual({ status: "waiting", waitingFor: "permission prompt" });
    writeEntry(root, 111, entry(111, { status: "idle" }));
    expect(readPeerStatus(root, target, alwaysAlive)).toEqual({ status: "idle", waitingFor: null });
  });

  it("is null when the process is gone or the registry entry was removed (a clean exit)", () => {
    writeEntry(root, 111, entry(111));
    expect(readPeerStatus(root, target, neverAlive)).toBeNull();
    fs.rmSync(path.join(root, "sessions", "111.json"));
    expect(readPeerStatus(root, target, alwaysAlive)).toBeNull();
  });

  it("is 'unknown' (not null) while the entry is unreadable — Claude Code rewrites it constantly", () => {
    fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(root, "sessions", "111.json"), "{\"pid\":111,\"status\":\"bu");
    expect(readPeerStatus(root, target, alwaysAlive)).toEqual({ status: "unknown", waitingFor: null });
    writeEntry(root, 111, entry(111, { status: "dancing" }));
    expect(readPeerStatus(root, target, alwaysAlive)).toEqual({ status: "unknown", waitingFor: null });
  });
});

describe("claude-peer: readCliMode", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-peer-"));
  });
  const jsonl = (records: Array<Record<string, unknown>>) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";

  it("maps bypassPermissions to bypass and everything else to prompting, from the newest record", () => {
    const file = path.join(root, "t.jsonl");
    fs.writeFileSync(file, jsonl([
      { type: "permission-mode", permissionMode: "bypassPermissions", sessionId: SID },
      { type: "user", uuid: "u1", permissionMode: "bypassPermissions", message: { role: "user", content: "hi" } },
    ]));
    expect(readCliMode(file)).toBe("bypass");
    fs.appendFileSync(file, jsonl([{ type: "user", uuid: "u2", permissionMode: "auto", message: { role: "user", content: "later" } }]));
    expect(readCliMode(file)).toBe("prompting");
    fs.appendFileSync(file, jsonl([{ type: "permission-mode", permissionMode: "plan", sessionId: SID }]));
    expect(readCliMode(file)).toBe("prompting");
  });

  it("is null when the transcript is missing or carries no mode", () => {
    expect(readCliMode(path.join(root, "none.jsonl"))).toBeNull();
    const file = path.join(root, "t.jsonl");
    fs.writeFileSync(file, jsonl([{ type: "ai-title", aiTitle: "x" }]));
    expect(readCliMode(file)).toBeNull();
  });

  it("finds a mode that sits before the last 256KB of a big transcript", () => {
    const file = path.join(root, "big.jsonl");
    fs.writeFileSync(file, jsonl([{ type: "permission-mode", permissionMode: "bypassPermissions", sessionId: SID }]));
    const filler = { type: "assistant", uuid: "a", message: { content: [{ type: "text", text: "x".repeat(1000) }] } };
    fs.appendFileSync(file, jsonl(Array.from({ length: 400 }, () => filler)));
    expect(fs.statSync(file).size).toBeGreaterThan(256 * 1024);
    expect(readCliMode(file)).toBe("bypass");
  });
});

describe("claude-peer: wrapForPeer", () => {
  it("wraps in the tag Claude Code parses, attributes in its fixed order, note last", () => {
    expect(wrapForPeer("hello", { name: "tiny", mode: "bypass" })).toBe(
      `<cross-session-message from-name="tiny" from-mode="bypass">\nhello\n\n${PEER_NOTE}\n</cross-session-message>`,
    );
  });

  it("omits from-mode when the CLI's mode is unknown", () => {
    expect(wrapForPeer("hello", { name: "tiny", mode: null })).toBe(
      `<cross-session-message from-name="tiny">\nhello\n\n${PEER_NOTE}\n</cross-session-message>`,
    );
  });

  it("escapes a closing tag inside the body the way Claude Code does, so its round-trip check still passes", () => {
    const out = wrapForPeer("a </cross-session-message> b </Cross-Session-Message> c <cross-session-message> d", { name: "tiny", mode: null });
    expect(out).toContain("a <\\/cross-session-message> b <\\/Cross-Session-Message> c <cross-session-message> d");
  });
});

/** A stand-in for the CLI's inbox: collects everything written until the client half-closes */
function fakeInbox(sockPath: string): { received: Promise<string>; close: () => void } {
  let resolve!: (s: string) => void;
  const received = new Promise<string>((r) => (resolve = r));
  const server = net.createServer((c) => {
    let buf = "";
    c.setEncoding("utf8");
    c.on("data", (d) => (buf += d));
    c.on("end", () => {
      resolve(buf);
      c.end();
    });
  });
  server.listen(sockPath);
  return { received, close: () => server.close() };
}

describe("claude-peer: readPeerToken", () => {
  it("finds the key file named after the pid and the sha256 of the socket path", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-peer-"));
    const target = { pid: 34979, sockPath: "/tmp/cc-socks/34979.sock" };
    const hash = crypto.createHash("sha256").update(target.sockPath).digest("hex");
    fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(root, "sessions", `34979.${hash}.key`), JSON.stringify({ peerToken: "0123456789abcdef0123456789abcdef", pidDomain: "darwin" }));
    fs.writeFileSync(path.join(root, "sessions", `1.${hash}.key`), JSON.stringify({ peerToken: "ffffffffffffffffffffffffffffffff" }));
    expect(readPeerToken(root, target)).toBe("0123456789abcdef0123456789abcdef");
    expect(readPeerToken(root, { pid: 2, sockPath: target.sockPath })).toBeNull();
    expect(readPeerToken(root, { pid: 34979, sockPath: "/private/tmp/cc-socks/34979.sock" })).toBeNull();
  });
});

describe("claude-peer: sendPeerMessage", () => {
  const FAST = { connectTimeoutMs: 1000, endDelayMs: 10 };
  let dir: string;
  beforeEach(() => {
    // Unix socket paths are capped at ~104 bytes, so keep the directory short
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tp-"));
  });

  it("writes an auth line then a user frame carrying session_id, msg_id and the content, then half-closes", async () => {
    const sockPath = path.join(dir, "1.sock");
    const inbox = fakeInbox(sockPath);
    await sendPeerMessage({ pid: 1, sockPath }, { agentSessionId: SID, msgId: "m-1", content: "<wrapped>", priority: "next" }, "0123456789abcdef0123456789abcdef", FAST);
    const lines = (await inbox.received).split("\n");
    inbox.close();
    expect(lines).toHaveLength(3); // two frames + trailing newline
    expect(JSON.parse(lines[0]!)).toEqual({ type: "auth", token: "0123456789abcdef0123456789abcdef" });
    expect(JSON.parse(lines[1]!)).toEqual({
      msgV: 1, msg_id: "m-1", session_id: SID, type: "user",
      message: { role: "user", content: "<wrapped>" }, priority: "next",
    });
    expect(lines[2]).toBe("");
  });

  it("sends without an auth line when there is no key (auth is optional on macOS)", async () => {
    const sockPath = path.join(dir, "2.sock");
    const inbox = fakeInbox(sockPath);
    await sendPeerMessage({ pid: 2, sockPath }, { agentSessionId: SID, msgId: "m-2", content: "x", priority: "next" }, null, FAST);
    const lines = (await inbox.received).split("\n");
    inbox.close();
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).type).toBe("user");
  });

  it("carries priority through (now = interrupt what the CLI is doing)", () => {
    const line = encodePeerFrames({ agentSessionId: SID, msgId: "m-5", content: "stop", priority: "now" }, null);
    expect(JSON.parse(line.trim()).priority).toBe("now");
  });

  it("rejects when nothing listens on the socket", async () => {
    const sockPath = path.join(dir, "gone.sock");
    await expect(sendPeerMessage({ pid: 3, sockPath }, { agentSessionId: SID, msgId: "m-3", content: "x", priority: "next" }, null, FAST))
      .rejects.toThrow(/ENOENT|ECONNREFUSED/);
  });

  it("refuses a frame over the CLI's 1MB line cap before connecting", () => {
    expect(() => encodePeerFrames({ agentSessionId: SID, msgId: "m-4", content: "x".repeat(1_048_576), priority: "next" }, null))
      .toThrow(/too large/);
  });
});

describe("claude-peer: summarizePeerInboxes", () => {
  it("counts open sessions, sockets, and stale sockets whose process is gone", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-peer-"));
    const socks = path.join(root, "cc-socks");
    fs.mkdirSync(socks);
    writeEntry(root, 1, entry(1));
    writeEntry(root, 2, entry(2, { sessionId: "other" }));
    writeEntry(root, 3, entry(3)); // dead
    for (const n of ["1.sock", "2.sock", "3.sock", "99.sock", "junk.txt"]) fs.writeFileSync(path.join(socks, n), "");
    expect(summarizePeerInboxes(root, socks, (pid) => pid === 1 || pid === 2)).toEqual({ open: 2, sockets: 4, stale: 2 });
  });

  it("is zeros when neither directory exists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-peer-"));
    expect(summarizePeerInboxes(root, path.join(root, "none"), () => true)).toEqual({ open: 0, sockets: 0, stale: 0 });
  });
});
