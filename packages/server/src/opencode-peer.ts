import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import type { TurnImage } from "./adapter.js";
import { oneLine, type ToolHint, type ToolKind } from "./tool-kinds.js";

/**
 * tinyd's side of talking to running opencode processes. The ONLY module that does (the read side
 * of opencode's storage is opencode-live.ts):
 *
 * 1. The person's own opencode (a TUI, or an `opencode serve` TUIs attach to), through tiny's
 *    plugin (opencode-plugin.ts holds its source and the wire format): its `<pid>.json` says what
 *    that process is doing, its `<pid>.sock` takes a prompt / an abort / a permission reply.
 * 2. tiny's own `opencode acp` child, through the HTTP server it opens on loopback (`--port`):
 *    opencode 1.18.35's ACP layer drops the permission prompts a subagent raises on its own session
 *    (acp/permission.ts returns without replying for a session ACP did not open, and nothing times
 *    out), so the turn hung forever; `GET /permission` lists them and `POST
 *    /permission/:id/reply` answers them.
 * 3. Which opencode processes exist at all (`pgrep`), for "is anybody there" questions the plugin
 *    cannot answer for processes it is not loaded in.
 *
 * Every read degrades to null / empty; every action throws, and the caller falls back.
 */

/** Set in the env of every opencode tiny runs turns in; tiny's plugin stays out of those */
export const OPENCODE_PEER_ENV = "TINY_OPENCODE_PEER";

export function opencodePeersDir(tinyHome: string): string {
  return path.join(tinyHome, "opencode-peers");
}

export interface OpencodePermissionRequest {
  id: string;
  /** The session asking: the turn's own session, or a subagent's */
  sessionID: string;
  /** The top-level session that subagent works for (= sessionID for the turn's own session) */
  root: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
}

export interface OpencodePeer {
  pid: number;
  kind: string;
  /** $XDG_DATA_HOME of that process (opencode.db lives in <dataHome>/opencode). null = not reported */
  dataHome: string | null;
  socket: string;
  /** Project directories this process serves (a TUI serves the one it was started in) */
  directories: string[];
  startedAt: number;
  pluginVersion: number;
  sessions: Record<string, { status: string; since: number; root: string }>;
  permissions: OpencodePermissionRequest[];
  questions: Array<{ id: string; sessionID: string; root: string }>;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function parsePeer(raw: string): OpencodePeer | null {
  let j: Record<string, any>;
  try {
    j = JSON.parse(raw) as Record<string, any>;
  } catch {
    return null; // caught mid-rename, or not ours
  }
  if (j.protocol !== 1 || typeof j.pid !== "number" || typeof j.socket !== "string") return null;
  const sessions: OpencodePeer["sessions"] = {};
  for (const [id, s] of Object.entries((j.sessions ?? {}) as Record<string, any>)) {
    if (s && typeof s.status === "string") {
      sessions[id] = { status: s.status, since: typeof s.since === "number" ? s.since : 0, root: typeof s.root === "string" ? s.root : id };
    }
  }
  const permissions: OpencodePermissionRequest[] = [];
  for (const r of Array.isArray(j.permissions) ? j.permissions : []) {
    if (!r || typeof r.id !== "string" || typeof r.sessionID !== "string") continue;
    permissions.push({
      id: r.id,
      sessionID: r.sessionID,
      root: typeof r.root === "string" ? r.root : r.sessionID,
      permission: typeof r.permission === "string" ? r.permission : "",
      patterns: strings(r.patterns),
      metadata: r.metadata && typeof r.metadata === "object" ? (r.metadata as Record<string, unknown>) : {},
    });
  }
  const questions: OpencodePeer["questions"] = [];
  for (const q of Array.isArray(j.questions) ? j.questions : []) {
    if (q && typeof q.id === "string" && typeof q.sessionID === "string") {
      questions.push({ id: q.id, sessionID: q.sessionID, root: typeof q.root === "string" ? q.root : q.sessionID });
    }
  }
  return {
    pid: j.pid,
    kind: typeof j.kind === "string" ? j.kind : "tui",
    dataHome: typeof j.dataHome === "string" && j.dataHome !== "" ? j.dataHome : null,
    socket: j.socket,
    directories: strings(j.directories),
    startedAt: typeof j.startedAt === "number" ? j.startedAt : 0,
    pluginVersion: typeof j.pluginVersion === "number" ? j.pluginVersion : 0,
    sessions,
    permissions,
    questions,
  };
}

/** One process's registration, fresh. null = gone (no file, or its pid is dead) */
export function readOpencodePeer(peersDir: string, pid: number, alive: (pid: number) => boolean = processAlive): OpencodePeer | null {
  if (!alive(pid)) return null;
  try {
    const peer = parsePeer(fs.readFileSync(path.join(peersDir, `${pid}.json`), "utf8"));
    return peer && peer.pid === pid ? peer : null;
  } catch {
    return null;
  }
}

/** Every live process the plugin registered. A killed process leaves its files behind; its pid is dead */
export function listOpencodePeers(peersDir: string, alive: (pid: number) => boolean = processAlive): OpencodePeer[] {
  let names: string[];
  try {
    names = fs.readdirSync(peersDir);
  } catch {
    return [];
  }
  const peers: OpencodePeer[] = [];
  for (const name of names) {
    const m = /^(\d+)\.json$/.exec(name);
    if (!m) continue;
    const peer = readOpencodePeer(peersDir, Number(m[1]), alive);
    if (peer) peers.push(peer);
  }
  return peers;
}

/** Remove what killed processes left behind. Returns how many processes' files went */
export function pruneOpencodePeers(peersDir: string, alive: (pid: number) => boolean = processAlive): number {
  let names: string[];
  try {
    names = fs.readdirSync(peersDir);
  } catch {
    return 0;
  }
  const dead = new Set<number>();
  for (const name of names) {
    const m = /^(\d+)\.(json|sock|json\.tmp)$/.exec(name);
    if (m && !alive(Number(m[1]))) {
      dead.add(Number(m[1]));
      fs.rmSync(path.join(peersDir, name), { force: true });
    }
  }
  return dead.size;
}

/** The processes working on this storage ($XDG_DATA_HOME); one that did not say is never taken for it */
export function peersOnStorage(peers: OpencodePeer[], dataHome: string): OpencodePeer[] {
  const want = path.resolve(dataHome);
  return peers.filter((p) => p.dataHome !== null && path.resolve(p.dataHome) === want);
}

/**
 * The process a message for this session goes to: one serving the session's directory (it can run
 * the session, and a TUI there shows it), preferring the one that last worked on this very session,
 * then the newest. null = nobody, and tiny runs the turn itself. Pass only peers on the session's storage
 */
export function pickOpencodePeer(peers: OpencodePeer[], cwd: string, agentSessionId: string): OpencodePeer | null {
  const here = peers.filter((p) => p.directories.includes(cwd));
  if (here.length === 0) return null;
  return [...here].sort((a, b) => {
    const sa = a.sessions[agentSessionId]?.since ?? -1;
    const sb = b.sessions[agentSessionId]?.since ?? -1;
    return sb - sa || b.startedAt - a.startedAt;
  })[0]!;
}

/** A turn is running on this session in that process (busy, or waiting to retry a failed request) */
export function peerSessionBusy(peer: OpencodePeer, agentSessionId: string): boolean {
  const s = peer.sessions[agentSessionId];
  return s !== undefined && s.status !== "idle";
}

/** When the session last went idle in that process (ms). null = not since the process started */
export function peerSessionIdleAt(peer: OpencodePeer, agentSessionId: string): number | null {
  const s = peer.sessions[agentSessionId];
  return s && s.status === "idle" ? s.since : null;
}

export interface OpencodePromptMessage {
  directory: string;
  sessionID: string;
  text: string;
  images?: TurnImage[];
  model?: { providerID: string; modelID: string };
  variant?: string;
  agent?: string;
}

const PEER_TIMEOUT_MS = 10_000;

/** One POST to a plugin's socket. Resolves on 200; throws with the plugin's own words otherwise */
function peerPost(socket: string, route: string, body: unknown, timeoutMs = PEER_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { socketPath: socket, method: "POST", path: route, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (raw += c));
        res.on("end", () => {
          if (res.statusCode === 200) return resolve();
          let msg = raw;
          try {
            msg = String((JSON.parse(raw) as { error?: unknown }).error ?? raw);
          } catch {
            // not JSON; keep the raw text
          }
          reject(new Error(`opencode answered ${res.statusCode}: ${msg}`));
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`opencode did not answer within ${timeoutMs}ms`)));
    req.on("error", reject);
    req.end(data);
  });
}

function extOf(mediaType: string): string {
  const sub = mediaType.split("/")[1] ?? "bin";
  return sub === "jpeg" ? "jpg" : sub.replace(/[^a-z0-9]/gi, "");
}

/** Hand a message to that process. It runs there as if typed into its prompt (queued behind a running turn) */
export function opencodePeerPrompt(peer: OpencodePeer, msg: OpencodePromptMessage): Promise<void> {
  const parts: unknown[] = [
    { type: "text", text: msg.text },
    ...(msg.images ?? []).map((img, i) => ({
      type: "file",
      mime: img.mediaType,
      url: `data:${img.mediaType};base64,${img.data}`,
      filename: `image-${i + 1}.${extOf(img.mediaType)}`,
    })),
  ];
  return peerPost(peer.socket, "/v1/prompt", {
    directory: msg.directory,
    sessionID: msg.sessionID,
    parts,
    ...(msg.model ? { model: msg.model } : {}),
    ...(msg.variant ? { variant: msg.variant } : {}),
    ...(msg.agent ? { agent: msg.agent } : {}),
  });
}

export function opencodePeerAbort(peer: OpencodePeer, r: { directory: string; sessionID: string }): Promise<void> {
  return peerPost(peer.socket, "/v1/abort", r);
}

export function opencodePeerReply(
  peer: OpencodePeer,
  r: { directory: string; sessionID: string; requestID: string; reply: "once" | "always" | "reject" },
): Promise<void> {
  return peerPost(peer.socket, "/v1/permission", r);
}

/** pids of every process named opencode. null = could not tell */
export function listOpencodePids(): number[] | null {
  return pgrep(["-x", "opencode"]);
}

/** pids of the opencode processes this process spawned itself (tiny's own `opencode acp`) */
export function ownOpencodePids(): number[] | null {
  return pgrep(["-P", String(process.pid), "-x", "opencode"]);
}

function pgrep(args: string[]): number[] | null {
  try {
    const out = execFileSync("pgrep", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 });
    return out.split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0);
  } catch (err) {
    // pgrep exits 1 when nothing matches
    return (err as { status?: number }).status === 1 ? [] : null;
  }
}

/** What a permission prompt looks like on the phone: the tool, what it would run, and the card's hint */
export function opencodePermissionView(r: OpencodePermissionRequest): { toolName: string; input: Record<string, unknown>; hint: ToolHint } {
  const kinds: Record<string, ToolKind> = {
    bash: "execute", edit: "edit", write: "edit", patch: "edit", read: "read",
    glob: "search", grep: "search", list: "search", webfetch: "fetch", websearch: "fetch",
  };
  const m = r.metadata;
  const pick = (k: string) => (typeof m[k] === "string" && m[k] !== "" ? (m[k] as string) : null);
  const what = pick("command") ?? pick("filepath") ?? pick("filePath") ?? pick("url") ?? pick("query") ?? r.patterns.join(", ");
  const input = { ...m };
  if (r.permission === "bash" && typeof input.command !== "string" && r.patterns.length > 0) input.command = r.patterns.join(" && ");
  const subagent = r.sessionID !== r.root;
  return {
    toolName: r.permission || "tool",
    input,
    hint: { kind: kinds[r.permission] ?? "other", summary: oneLine(`${subagent ? "(subagent) " : ""}${what || r.permission}`) },
  };
}

/** A free TCP port on loopback, for `opencode acp --port` */
export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

function serverUrl(port: number, route: string, cwd: string): string {
  return `http://127.0.0.1:${port}${route}?directory=${encodeURIComponent(cwd)}`;
}

/** Pending permission prompts in tiny's own `opencode acp` (its HTTP server on `port`), all sessions */
export async function opencodeServerPermissions(port: number, cwd: string, timeoutMs = 3000): Promise<Array<Omit<OpencodePermissionRequest, "root">>> {
  const res = await fetch(serverUrl(port, "/permission", cwd), { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`GET /permission answered ${res.status}`);
  const list = (await res.json()) as unknown;
  if (!Array.isArray(list)) return [];
  const out: Array<Omit<OpencodePermissionRequest, "root">> = [];
  for (const r of list as Array<Record<string, any>>) {
    if (!r || typeof r.id !== "string" || typeof r.sessionID !== "string") continue;
    out.push({
      id: r.id,
      sessionID: r.sessionID,
      permission: typeof r.permission === "string" ? r.permission : "",
      patterns: strings(r.patterns),
      metadata: r.metadata && typeof r.metadata === "object" ? (r.metadata as Record<string, unknown>) : {},
    });
  }
  return out;
}

export async function opencodeServerReply(port: number, cwd: string, requestID: string, reply: "once" | "reject", timeoutMs = 3000): Promise<void> {
  const res = await fetch(serverUrl(port, `/permission/${encodeURIComponent(requestID)}/reply`, cwd), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reply }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`POST /permission/${requestID}/reply answered ${res.status}`);
}
