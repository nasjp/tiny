import fs from "node:fs";
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
