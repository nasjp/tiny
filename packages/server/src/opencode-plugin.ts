import fs from "node:fs";
import path from "node:path";
import { opencodeXdg } from "./agents/opencode.js";
import { OPENCODE_PEER_ENV } from "./opencode-peer.js";

/**
 * The opencode plugin `tiny live on --profile <opencode profile>` installs (opencode loads every
 * `<config>/opencode/plugin/*.js`). It is how a message from the phone reaches the opencode the
 * person has open in a terminal:
 *
 * - A plain `opencode` TUI opens no TCP port (1.18.35: only --port/--hostname/--mdns flags do) and
 *   redraws only from its own process's events — a turn another process writes into the same
 *   opencode.db never shows up there until the TUI restarts. Plugins run inside that process (the
 *   TUI's server worker) with an SDK client wired to it, so a prompt sent through the plugin runs
 *   in the person's TUI and shows there as it happens (measured 2026-10-12 with a TUI in tmux).
 * - The plugin also sees every bus event, which is what tinyd needs to know what that process is
 *   doing: which sessions are busy, and the permission prompts it is showing — subagent ones too.
 *
 * Wire format (protocol 1), all under PEERS_DIR (0700, inside tiny's home):
 * - `<pid>.json`, rewritten atomically whenever something tinyd cares about changes:
 *   { protocol, pluginVersion, pid, kind: "tui"|"serve", dataHome, socket, directories, startedAt, updatedAt,
 *     sessions: { [id]: { status, since, root } }, permissions: [request + root + askedAt],
 *     questions: [request + root + askedAt] }
 * - `<pid>.sock`, an HTTP server on a unix socket: POST /v1/prompt, /v1/abort, /v1/permission.
 * The plugin removes both on a process exit it gets to see — the TUI's worker never sees one
 * (measured 2026-10-12: quitting the TUI leaves them) — so tinyd ignores entries whose pid is dead
 * and prunes them on its 5s scan tick.
 *
 * The plugin is plain JS with node builtins only (it runs in opencode's Bun), never throws into
 * opencode, and does nothing in tiny's own `opencode acp` children (TINY_OPENCODE_PEER=off) or in a
 * one-shot `opencode run`. tinyd's side of the wire is opencode-peer.ts.
 */

/** Bumped whenever the source below changes, so `tiny doctor` can tell an outdated copy */
export const OPENCODE_PLUGIN_VERSION = 1;

/** Marks the file as tiny's: `tiny live off` only ever deletes a file that starts with this */
const HEADER = "// tiny-opencode-peer";

export function opencodePluginPath(profileDir: string): string {
  return path.join(opencodeXdg(profileDir).config, "opencode", "plugin", "tiny.js");
}

export function opencodePluginSource(peersDir: string): string {
  return `${HEADER} v${OPENCODE_PLUGIN_VERSION} — installed by \`tiny live on\`, removed by \`tiny live off\`. Do not edit.
// Lets tinyd (the tiny daemon on this Mac) hand messages from your phone to this opencode process,
// so they run — and show — in the terminal you have open. https://github.com/nasjp/tiny
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const PEERS_DIR = ${JSON.stringify(peersDir)};
const PROTOCOL = 1;
const PLUGIN_VERSION = ${OPENCODE_PLUGIN_VERSION};
const KEY = Symbol.for("tiny.opencode.peer");
const MAX_SESSIONS = 200;

// The TUI runs its server (and with it every plugin) in a worker started from cli/tui/worker.js;
// \`opencode serve\` / \`web\` are what attached TUIs talk to. Anything else never holds a session
// for the person: \`run\` is one prompt and out, \`acp\` is tiny's own child
function peerKind(argv) {
  if (argv.some((a) => /[\\\\/]cli[\\\\/]tui[\\\\/]worker\\.[cm]?js$/.test(String(a)))) return "tui";
  const sub = argv.slice(2).find((a) => !String(a).startsWith("-"));
  return sub === "serve" || sub === "web" ? "serve" : null;
}

function createPeer(kind) {
  const pid = process.pid;
  const socket = path.join(PEERS_DIR, pid + ".sock");
  const file = path.join(PEERS_DIR, pid + ".json");
  const startedAt = Date.now();
  const clients = new Map();
  const parents = new Map();
  const sessions = new Map();
  const permissions = new Map();
  const questions = new Map();
  let timer = null;
  let server = null;
  let closed = false;
  // The registration is what tells tinyd this process can take a message: never before the socket listens
  let listening = false;

  const root = (id) => {
    let cur = id;
    for (let i = 0; i < 32; i++) {
      const up = parents.get(cur);
      if (!up) return cur;
      cur = up;
    }
    return cur;
  };

  // Which storage this process works on (where opencode.db lives): the same TUI directory can belong
  // to two opencodes with different XDG trees, and a message must go to the one holding the session
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");

  const snapshot = () => ({
    protocol: PROTOCOL,
    pluginVersion: PLUGIN_VERSION,
    pid,
    kind,
    dataHome,
    socket,
    directories: [...clients.keys()],
    startedAt,
    updatedAt: Date.now(),
    sessions: Object.fromEntries([...sessions].map(([id, s]) => [id, { ...s, root: root(id) }])),
    permissions: [...permissions.values()].map((r) => ({ ...r, root: root(r.sessionID) })),
    questions: [...questions.values()].map((r) => ({ ...r, root: root(r.sessionID) })),
  });

  const write = () => {
    timer = null;
    if (closed || !listening) return;
    try {
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(snapshot()), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {}
  };
  const changed = () => {
    if (!timer && !closed) timer = setTimeout(write, 30);
  };

  const prune = () => {
    if (sessions.size <= MAX_SESSIONS) return;
    const idle = [...sessions].filter(([, s]) => s.status === "idle").sort((a, b) => a[1].since - b[1].since);
    for (const [id] of idle.slice(0, sessions.size - MAX_SESSIONS)) sessions.delete(id);
  };

  const onEvent = (event) => {
    const p = (event && event.properties) || {};
    switch (event && event.type) {
      case "session.created":
      case "session.updated": {
        const info = p.info;
        if (info && info.id && info.parentID) parents.set(info.id, info.parentID);
        return;
      }
      case "session.status": {
        const type = p.status && p.status.type;
        if (!p.sessionID || !type) return;
        sessions.set(p.sessionID, { status: type, since: Date.now() });
        if (type === "idle") {
          // A prompt cancelled by an abort goes away without permission.replied (opencode 1.18.35)
          for (const [id, r] of permissions) if (r.sessionID === p.sessionID) permissions.delete(id);
          for (const [id, r] of questions) if (r.sessionID === p.sessionID) questions.delete(id);
        }
        prune();
        changed();
        return;
      }
      case "permission.asked":
        if (!p.id || !p.sessionID) return;
        permissions.set(p.id, {
          id: p.id, sessionID: p.sessionID, permission: String(p.permission || ""),
          patterns: Array.isArray(p.patterns) ? p.patterns : [], metadata: p.metadata || {},
          tool: p.tool || null, askedAt: Date.now(),
        });
        changed();
        return;
      case "permission.replied":
        if (permissions.delete(p.requestID)) changed();
        return;
      case "question.asked":
        if (!p.id || !p.sessionID) return;
        questions.set(p.id, { id: p.id, sessionID: p.sessionID, questions: p.questions || [], tool: p.tool || null, askedAt: Date.now() });
        changed();
        return;
      case "question.replied":
      case "question.rejected":
        if (questions.delete(p.requestID)) changed();
        return;
    }
  };

  const reply = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const readJson = (req) =>
    new Promise((resolve, reject) => {
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch (e) {
          reject(e);
        }
      });
      req.on("error", reject);
    });
  const failure = (r) => {
    const e = r && r.error;
    if (!e) return null;
    return typeof e === "string" ? e : (e.data && e.data.message) || e.message || e.name || JSON.stringify(e);
  };

  const handle = async (req, res) => {
    if (req.method !== "POST") return reply(res, 405, { error: "POST only" });
    let body;
    try {
      body = await readJson(req);
    } catch {
      return reply(res, 400, { error: "bad json" });
    }
    const client = clients.get(body.directory) || clients.values().next().value;
    if (!client) return reply(res, 503, { error: "no opencode instance in this process" });
    if (typeof body.sessionID !== "string" || body.sessionID === "") return reply(res, 400, { error: "sessionID required" });
    const url = new URL(req.url || "/", "http://peer");
    let r;
    if (url.pathname === "/v1/prompt") {
      r = await client.session.promptAsync({
        path: { id: body.sessionID },
        body: {
          parts: Array.isArray(body.parts) ? body.parts : [],
          ...(body.model ? { model: body.model } : {}),
          ...(body.variant ? { variant: body.variant } : {}),
          ...(body.agent ? { agent: body.agent } : {}),
        },
      });
    } else if (url.pathname === "/v1/abort") {
      r = await client.session.abort({ path: { id: body.sessionID } });
    } else if (url.pathname === "/v1/permission") {
      r = await client.postSessionIdPermissionsPermissionId({
        path: { id: body.sessionID, permissionID: body.requestID },
        body: { response: body.reply },
      });
    } else {
      return reply(res, 404, { error: "unknown route" });
    }
    const err = failure(r);
    return err ? reply(res, 502, { error: err }) : reply(res, 200, { ok: true });
  };

  const close = () => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    try { if (server) server.close(); } catch {}
    try { fs.unlinkSync(file); } catch {}
    try { fs.unlinkSync(socket); } catch {}
  };

  const start = () => {
    try {
      fs.mkdirSync(PEERS_DIR, { recursive: true, mode: 0o700 });
      try { fs.unlinkSync(socket); } catch {} // left by an earlier process that had this pid
      server = http.createServer((req, res) => {
        handle(req, res).catch((e) => {
          try { reply(res, 500, { error: String((e && e.message) || e) }); } catch {}
        });
      });
      server.on("error", () => {});
      server.listen(socket, () => {
        try { fs.chmodSync(socket, 0o600); } catch {}
        listening = true;
        changed();
      });
      process.on("exit", close);
    } catch {}
  };

  start();
  return {
    attach: (directory, client) => {
      if (typeof directory === "string" && client) {
        clients.set(directory, client);
        changed();
      }
    },
    detach: (directory) => {
      if (clients.delete(directory)) changed();
    },
    onEvent,
    close,
    flush: write,
  };
}

export const TinyPeer = async (input) => {
  try {
    if (process.env.${OPENCODE_PEER_ENV} === "off") return {};
    const kind = peerKind(process.argv);
    if (!kind) return {};
    if (!globalThis[KEY]) globalThis[KEY] = createPeer(kind);
    const peer = globalThis[KEY];
    peer.attach(input.directory, input.client);
    return {
      event: async ({ event }) => {
        try { peer.onEvent(event); } catch {}
      },
      dispose: async () => {
        try { peer.detach(input.directory); } catch {}
      },
    };
  } catch {
    return {};
  }
};
`;
}

/** What is installed at the plugin path. version null = absent, or not tiny's file */
export function readOpencodePlugin(profileDir: string): { installed: boolean; version: number | null } {
  let head: string;
  try {
    head = fs.readFileSync(opencodePluginPath(profileDir), "utf8").slice(0, 200);
  } catch {
    return { installed: false, version: null };
  }
  const m = head.startsWith(HEADER) ? /^\/\/ tiny-opencode-peer v(\d+)/.exec(head) : null;
  return { installed: m !== null, version: m ? Number(m[1]) : null };
}

/** Write (or rewrite) the plugin. Refuses to overwrite a tiny.js that is not tiny's */
export function installOpencodePlugin(profileDir: string, peersDir: string): string {
  const file = opencodePluginPath(profileDir);
  if (fs.existsSync(file) && !readOpencodePlugin(profileDir).installed) {
    throw new Error(`${file} exists and is not tiny's plugin; move it away and run this again`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, opencodePluginSource(peersDir));
  return file;
}

/** Delete the plugin if it is tiny's. true = it was there and is gone */
export function removeOpencodePlugin(profileDir: string): boolean {
  if (!readOpencodePlugin(profileDir).installed) return false;
  fs.rmSync(opencodePluginPath(profileDir), { force: true });
  return true;
}
