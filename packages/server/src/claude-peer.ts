import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

/**
 * Live-join into a running Claude Code session over its cross-session messaging socket.
 *
 * Everything here rides on UNDOCUMENTED interfaces of Claude Code (2.1.251, read out of the binary
 * and verified on a real Mac — see docs/cc-socks-protocol-2026-08-31.html, local only):
 *
 *   <configDir>/sessions/<pid>.json                 registry: sessionId, messagingSocketPath, status
 *   <configDir>/sessions/<pid>.<sha256(sock)>.key   {"peerToken": "<hex32>"}
 *   <messagingSocketPath>                           a UDS taking newline-delimited JSON frames
 *
 * This is the ONLY file allowed to know about them. Every function degrades to null (or throws
 * from send) so the caller can fall back to Step 1 behaviour: 409 while the CLI holds the session.
 */

export interface PeerTarget {
  pid: number;
  /** The socket the registry advertises. Never rebuilt from the pid: XDG_RUNTIME_DIR moves it */
  sockPath: string;
}

export interface PeerStatus {
  /** unknown = the entry could not be read right now (it is rewritten on every status change) */
  status: "busy" | "idle" | "waiting" | "shell" | "unknown";
  /** e.g. "permission prompt" while status is waiting */
  waitingFor: string | null;
}

/** peerProtocol values this code understands. A newer Claude Code means we stop guessing */
const KNOWN_PEER_PROTOCOLS = new Set([1]);
const STATUSES = new Set(["busy", "idle", "waiting", "shell"]);

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readEntry(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null; // missing, or caught mid-write — both normal
  }
}

/**
 * The live CLI process that has this session open, or null when there is none we can talk to.
 * Registry-only on purpose: sockets alone (`/tmp/cc-socks/*.sock`) do not say which session they
 * belong to, and a frame carrying the wrong session_id is silently dropped by the receiver anyway.
 */
export function resolvePeerTarget(
  configDir: string,
  agentSessionId: string,
  alive: (pid: number) => boolean = processAlive,
): PeerTarget | null {
  const dir = path.join(configDir, "sessions");
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    return null;
  }
  for (const name of names) {
    const e = readEntry(path.join(dir, name));
    if (!e || e.sessionId !== agentSessionId) continue;
    if (typeof e.peerProtocol !== "number" || !KNOWN_PEER_PROTOCOLS.has(e.peerProtocol)) continue;
    if (typeof e.pid !== "number" || typeof e.messagingSocketPath !== "string" || e.messagingSocketPath === "") continue;
    if (!alive(e.pid)) continue;
    return { pid: e.pid, sockPath: e.messagingSocketPath };
  }
  return null;
}

/**
 * What the CLI is doing right now. null means the CLI is gone (process dead, or it removed its
 * registry entry on exit). An unreadable entry is "unknown", never "gone".
 */
export function readPeerStatus(
  configDir: string,
  target: PeerTarget,
  alive: (pid: number) => boolean = processAlive,
): PeerStatus | null {
  if (!alive(target.pid)) return null;
  const file = path.join(configDir, "sessions", `${target.pid}.json`);
  if (!fs.existsSync(file)) return null;
  const e = readEntry(file);
  if (!e || typeof e.status !== "string" || !STATUSES.has(e.status)) return { status: "unknown", waitingFor: null };
  return {
    status: e.status as PeerStatus["status"],
    waitingFor: typeof e.waitingFor === "string" ? e.waitingFor : null,
  };
}

export type CliMode = "bypass" | "prompting";

/** Only read this much of the tail first; every user record carries the mode, so it is almost always enough */
const MODE_TAIL_BYTES = 256 * 1024;

/** Second look when the 256KB tail had no mode. Beyond this we give up and let the process argv decide */
const MODE_FALLBACK_BYTES = 8 * 1024 * 1024;

function readTail(file: string, bytes: number): { text: string; whole: boolean } | null {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    // A short read is legal; the untouched zero bytes at the end would otherwise corrupt the last line
    const read = fs.readSync(fd, buf, 0, buf.length, start);
    return { text: buf.subarray(0, read).toString("utf8"), whole: start === 0 };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function lastPermissionMode(text: string): string | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"permissionMode"')) continue;
    try {
      const r = JSON.parse(line) as { type?: unknown; permissionMode?: unknown };
      if ((r.type === "permission-mode" || r.type === "user") && typeof r.permissionMode === "string") return r.permissionMode;
    } catch {
      // the first line of a tail is usually cut in half; the last one may be mid-write
    }
  }
  return null;
}

/**
 * The CLI's current permission mode, in the two words the peer gate understands. A message that
 * asserts the receiver's own mode is delivered at once; one that asserts nothing is HELD by a
 * bypassPermissions session until the user approves it in the terminal (measured 2026-08-31).
 * plan counts as prompting: whether bypass is available inside plan mode cannot be read from here.
 */
export function readCliMode(transcriptFile: string): CliMode | null {
  const tail = readTail(transcriptFile, MODE_TAIL_BYTES);
  if (tail === null) return null;
  let mode = lastPermissionMode(tail.text);
  if (mode === null && !tail.whole) {
    const more = readTail(transcriptFile, MODE_FALLBACK_BYTES);
    if (more !== null) mode = lastPermissionMode(more.text);
  }
  if (mode === null) return null;
  return mode === "bypassPermissions" ? "bypass" : "prompting";
}

/**
 * The mode the CLI process was started with, read from its argv (`ps`). Used when the transcript
 * cannot tell (a session that has not run a turn yet has no transcript file). `--dangerously-skip-
 * permissions` / `--permission-mode bypassPermissions` mean bypass; any other start is prompting
 * (default / auto / acceptEdits / plan). null when the process cannot be inspected.
 */
export function readProcessMode(
  pid: number,
  ps: (pid: number) => string | null = psArgs,
): CliMode | null {
  const args = ps(pid);
  if (args === null) return null;
  if (/(^|\s)--dangerously-skip-permissions(\s|$)/.test(args)) return "bypass";
  if (/(^|\s)--permission-mode(=|\s+)bypassPermissions(\s|$)/.test(args)) return "bypass";
  return "prompting";
}

function psArgs(pid: number): string | null {
  try {
    // Spawned processes must never inherit ANTHROPIC_API_KEY (repo rule), even a `ps`
    const { ANTHROPIC_API_KEY: _omit, ...env } = process.env;
    const out = execFileSync("ps", ["-o", "args=", "-p", String(pid)], { env, encoding: "utf8", timeout: 2000 });
    const line = out.trim();
    return line === "" ? null : line;
  } catch {
    return null;
  }
}

export const PEER_TAG = "cross-session-message";

/**
 * Appended to every message. Without it the model reads the CLI's "another Claude session sent a
 * message" framing literally and tries to SendMessage the phone back (24s wasted, measured).
 * Placed LAST so the CLI's one-line preview starts with the user's own words.
 */
export const PEER_NOTE =
  "(Sent by your user from their phone via tiny — the same person who runs this terminal. " +
  "Answer here as usual; there is no peer agent to reply to, so do not use SendMessage.)";

/**
 * Sent with priority "now" when the person taps Stop on the phone. "now" makes the CLI abandon the
 * turn it is running and take this instead (measured), which is as close to an interrupt as the
 * socket offers; the one-line reply keeps the exchange readable in both places.
 */
export const PEER_STOP =
  "Stop — the user pressed Stop on their phone. Abandon the current task and reply with one short line.";

/** Claude Code escapes a closing tag in the body as `<\/tag` (case-insensitive) and re-derives the wrapper to verify it */
const CLOSE_TAG_RE = new RegExp(`<(?=/${PEER_TAG})`, "gi");

/**
 * Wrap a message the way Claude Code's own SendMessage does. Attribute order is fixed (from-name,
 * from-mode): the receiver regenerates the wrapper and compares, and a mismatch turns the whole
 * thing into plain text — no name in the CLI, no mode assertion, and a bypass session holds it.
 */
export function wrapForPeer(text: string, opts: { name: string; mode: CliMode | null }): string {
  const attrs = [`from-name="${opts.name}"`, ...(opts.mode ? [`from-mode="${opts.mode}"`] : [])].join(" ");
  const body = text.replace(CLOSE_TAG_RE, "<\\");
  return `<${PEER_TAG} ${attrs}>\n${body}\n\n${PEER_NOTE}\n</${PEER_TAG}>`;
}

export interface PeerFrame {
  /** The receiver drops a frame whose session_id is not its own — protects against a recycled pid */
  agentSessionId: string;
  /** Comes back verbatim as origin.msg_id on the transcript record: the only delivery receipt we get */
  msgId: string;
  /** Already wrapped (wrapForPeer) */
  content: string;
  /** next = after whatever the CLI is doing (its default); now = interrupt it (used for Stop) */
  priority: "next" | "now";
}

/** The receiver closes the connection on a longer line (auth line included) */
const MAX_LINE_CHARS = 1_048_576;
const CONNECT_TIMEOUT_MS = 5000;
/** Claude Code's own sender waits this long before half-closing on macOS; copy it */
const END_DELAY_MS = 150;

/** The peer token published for this socket, or null when there is none (the inbox then accepts unauthenticated frames on macOS) */
export function readPeerToken(configDir: string, target: PeerTarget): string | null {
  const hash = crypto.createHash("sha256").update(target.sockPath).digest("hex");
  const file = path.join(configDir, "sessions", `${target.pid}.${hash}.key`);
  try {
    const token = (JSON.parse(fs.readFileSync(file, "utf8")) as { peerToken?: unknown }).peerToken;
    return typeof token === "string" && /^[0-9a-f]{32}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

const PEER_AUTH_TYPE = "auth";

/** The bytes written to the socket: an optional auth line, then the user frame, newline-terminated */
export function encodePeerFrames(frame: PeerFrame, token: string | null): string {
  const user = JSON.stringify({
    msgV: 1,
    msg_id: frame.msgId,
    session_id: frame.agentSessionId,
    type: "user",
    message: { role: "user", content: frame.content },
    priority: frame.priority,
  });
  if (user.length + 1 > MAX_LINE_CHARS) {
    throw new Error(`message too large for the CLI inbox (${user.length} chars, limit ${MAX_LINE_CHARS})`);
  }
  return (token ? JSON.stringify({ type: PEER_AUTH_TYPE, token }) + "\n" : "") + user + "\n";
}

/** Deliver one frame. Resolves when the connection has closed; rejects on connect failure or timeout */
export function sendPeerMessage(
  target: PeerTarget,
  frame: PeerFrame,
  token: string | null,
  timing: { connectTimeoutMs: number; endDelayMs: number } = { connectTimeoutMs: CONNECT_TIMEOUT_MS, endDelayMs: END_DELAY_MS },
): Promise<void> {
  const payload = encodePeerFrames(frame, token);
  return new Promise((resolve, reject) => {
    const sock = net.connect({ path: target.sockPath });
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(err);
    };
    sock.setTimeout(timing.connectTimeoutMs, () => fail(new Error(`timed out sending to ${target.sockPath}`)));
    sock.on("error", fail);
    sock.on("connect", () => {
      sock.write(payload);
      setTimeout(() => {
        if (!sock.destroyed) sock.end();
      }, timing.endDelayMs);
    });
    sock.on("close", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
  });
}

/** Where Claude Code puts its sockets by default on macOS (XDG_RUNTIME_DIR overrides it per session) */
export const DEFAULT_SOCKETS_DIR = "/tmp/cc-socks";

/** For `tiny doctor`: how many Claude Code sessions are open, and how many socket files are left behind by dead ones */
export function summarizePeerInboxes(
  configDir: string,
  socketsDir: string = DEFAULT_SOCKETS_DIR,
  alive: (pid: number) => boolean = processAlive,
): { open: number; sockets: number; stale: number } {
  let open = 0;
  try {
    for (const name of fs.readdirSync(path.join(configDir, "sessions")).filter((n) => /^\d+\.json$/.test(n))) {
      const e = readEntry(path.join(configDir, "sessions", name));
      if (e && typeof e.pid === "number" && alive(e.pid)) open++;
    }
  } catch {
    // no registry: zero open sessions
  }
  let sockets = 0;
  let stale = 0;
  try {
    for (const name of fs.readdirSync(socketsDir)) {
      const m = /^(\d+)\.sock$/.exec(name);
      if (!m) continue;
      sockets++;
      if (!alive(Number(m[1]))) stale++;
    }
  } catch {
    // no sockets directory
  }
  return { open, sockets, stale };
}
