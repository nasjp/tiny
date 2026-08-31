import fs from "node:fs";
import path from "node:path";

/**
 * Claude Code's live-session registry (`<configDir>/sessions/<pid>.json`).
 * This is an UNDOCUMENTED interface, so we only ever read it, and we degrade to
 * "cannot tell" (null) rather than guessing. Callers must not block on null.
 */

/** peerProtocol values this code understands. A newer Claude Code means we stop guessing */
const KNOWN_PEER_PROTOCOLS = new Set([1]);

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Session ids the registry currently reports as open, or null when it cannot be read.
 * Read this ONCE when checking many sessions — the list endpoint asks for every row.
 */
export function readLiveSessionIds(
  configDir: string,
  alive: (pid: number) => boolean = processAlive,
): Set<string> | null {
  const dir = path.join(configDir, "sessions");
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return null; // no registry at all
  }

  const ids = new Set<string>();
  let understood = 0;
  for (const name of names) {
    let entry: { pid?: unknown; sessionId?: unknown; peerProtocol?: unknown };
    try {
      entry = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as typeof entry;
    } catch {
      continue; // a half-written entry is normal
    }
    if (typeof entry.peerProtocol !== "number" || !KNOWN_PEER_PROTOCOLS.has(entry.peerProtocol)) continue;
    // Claude Code writes these entries while running, so a half-written one is normal. Treat it
    // like a parse failure: counting it as understood would turn "we could not read this session's
    // entry" into a confident "that session is not open", which is the one wrong answer we cannot give
    if (typeof entry.sessionId !== "string" || typeof entry.pid !== "number") continue;
    let running: boolean;
    try {
      running = alive(entry.pid);
    } catch {
      continue; // cannot tell for this entry, so it must not count as understood either
    }
    understood++;
    if (running) ids.add(entry.sessionId);
  }
  // Understood nothing = we cannot tell. Understood something = absence means "not open"
  return understood > 0 ? ids : null;
}

/**
 * Whether the agent's own CLI still has this session open.
 * Returns null when it cannot be determined (no registry, unreadable, unknown protocol).
 */
export function isSessionLive(
  configDir: string,
  agentSessionId: string,
  alive: (pid: number) => boolean = processAlive,
): boolean | null {
  const ids = readLiveSessionIds(configDir, alive);
  return ids === null ? null : ids.has(agentSessionId);
}
