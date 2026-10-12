import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { buildAdapters } from "./adapters.js";
import { ensureDirs, tinyPaths } from "./config.js";
import { createApp } from "./api.js";
import { AuthService } from "./auth.js";
import { readLiveSessions, type LiveSessionEntry } from "./claude-live.js";
import { codexThreadHolders } from "./codex-live.js";
import { deleteCodexQueued, queueCodexMessage } from "./codex-peer.js";
import { opencodeXdg } from "./agents/opencode.js";
import {
  listOpencodePeers, listOpencodePids, opencodePeerAbort, opencodePeerPrompt, opencodePeerReply, opencodePeersDir, ownOpencodePids,
  peerSessionBusy, peerSessionIdleAt, peersOnStorage, pickOpencodePeer, pruneOpencodePeers, readOpencodePeer, type OpencodePeer,
} from "./opencode-peer.js";
import { readCliMode, readPeerStatus, readPeerToken, readProcessMode, resolvePeerTarget, sendPeerMessage } from "./claude-peer.js";
import { findTranscript } from "./claude-transcript.js";
import { FileOutbox } from "./outbox.js";
import { openDb } from "./db.js";
import { PermissionBroker } from "./permission-broker.js";
import { profileDir, readProfileLive } from "./profiles.js";
import { PushClient } from "./push-client.js";
import { SessionManager } from "./session-manager.js";
import type { CodexPeerBridge, OpencodePeerBridge, OpencodeTarget, PeerBridge } from "./session-manager.js";
import { loadSettings } from "./settings.js";
import { makeMcpLaunch } from "./mcp-launch.js";
import { createStores } from "./stores.js";
import type { SessionRecord } from "./types.js";
import { UsageService } from "./usage.js";
import { registerWs } from "./ws.js";
import os from "node:os";

export interface RunningServer {
  port: number;
  url: string;
  close: () => Promise<void>;
  manager: SessionManager;
  auth: AuthService;
  push: PushClient;
}

export async function startServer(env: Record<string, string | undefined> = process.env): Promise<RunningServer> {
  const paths = tinyPaths(env);
  ensureDirs(paths);
  const db = openDb(paths.dbFile);
  const stores = createStores(db);

  const broker = new PermissionBroker();
  const outbox = new FileOutbox(paths.outboxDir, stores.files);
  const auth = new AuthService(stores, paths.secretFile);
  auth.cliToken(); // generate it on first startup
  // The session list polls every 4s and asks for every row, so read the registry at most once
  // per window instead of once per session
  const LIVE_TTL_MS = 2000;
  let liveCache: { at: number; byDir: Map<string, Map<string, LiveSessionEntry> | null> } | null = null;

  function liveEntries(configDir: string): Map<string, LiveSessionEntry> | null {
    const now = Date.now();
    if (!liveCache || now - liveCache.at > LIVE_TTL_MS) liveCache = { at: now, byDir: new Map() };
    const cached = liveCache.byDir.get(configDir);
    if (cached !== undefined) return cached;
    const entries = readLiveSessions(configDir);
    liveCache.byDir.set(configDir, entries);
    return entries;
  }

  /** The registry's view of the CLI holding a session: undefined = not a Claude session / no config dir */
  const liveEntriesOf = (s: SessionRecord): Map<string, LiveSessionEntry> | null | undefined => {
    if (s.agent !== "claude" || !s.agentSessionId) return undefined;
    try {
      return liveEntries(profileDir(paths.profilesDir, s.profile));
    } catch {
      return undefined; // a profile whose configDir vanished must not break the list
    }
  };

  // Whether the agent's own CLI still holds a session. SessionManager uses it to refuse a turn that
  // would race the CLI, the API to report cliLive, so BOTH must get the same function
  // Process-level evidence per agent, cached like the registry (the list asks per row every poll)
  const EXTERNAL_TTL_MS = 2000;

  // opencode: the processes tiny's plugin registered (what each is doing, per session) and whether
  // any opencode runs without it (then nobody can say what that one is doing). One look serves every
  // row of a list poll
  const peersDir = opencodePeersDir(paths.home);
  let ocScan: { at: number; peers: OpencodePeer[]; strangers: boolean | null } | null = null;
  const opencodeScan = () => {
    if (ocScan && Date.now() - ocScan.at < EXTERNAL_TTL_MS) return ocScan;
    const peers = listOpencodePeers(peersDir);
    const all = listOpencodePids();
    const own = ownOpencodePids(); // tiny's own `opencode acp`, which is tiny's turn, not the person's
    const known = new Set([...peers.map((p) => p.pid), ...(own ?? [])]);
    const strangers = all === null || own === null ? null : all.some((pid) => !known.has(pid));
    ocScan = { at: Date.now(), peers, strangers };
    return ocScan;
  };
  /** The registered processes working on this session's storage */
  const opencodePeersOf = (s: SessionRecord): OpencodePeer[] => {
    try {
      return peersOnStorage(opencodeScan().peers, opencodeXdg(profileDir(paths.profilesDir, s.profile)).data);
    } catch {
      return []; // a vanished profile
    }
  };

  const externalCache = new Map<string, { at: number; busy: boolean | null }>();
  const externalBusy = (s: SessionRecord): boolean | null => {
    if (!s.agentSessionId) return null;
    const cached = externalCache.get(s.id);
    if (cached && Date.now() - cached.at < EXTERNAL_TTL_MS) return cached.busy;
    let busy: boolean | null = null;
    try {
      const dir = profileDir(paths.profilesDir, s.profile);
      if (s.agent === "codex") {
        // Measured: codex holds the thread's writer lock open for the whole turn
        busy = codexThreadHolders(dir, s.agentSessionId).length > 0;
      } else if (s.agent === "opencode") {
        // A registered process says so outright. Otherwise: nobody, unless an opencode runs that
        // tiny's plugin is not loaded in (started before `tiny live on`, another config) — that one
        // could be running this very session, and nothing says it is not
        // A process that has worked on the session and reports it idle is the authority on it
        const id = s.agentSessionId;
        const mine = opencodePeersOf(s);
        if (mine.some((p) => peerSessionBusy(p, id))) busy = true;
        else if (mine.some((p) => p.sessions[id] !== undefined)) busy = false;
        else busy = opencodeScan().strangers === false ? false : null;
      }
    } catch {
      busy = null;
    }
    externalCache.set(s.id, { at: Date.now(), busy });
    return busy;
  };

  const isCliLive = (s: SessionRecord): boolean | null => {
    // codex: whoever holds the thread's writer lock has the session open in a CLI
    if (s.agent === "codex" && s.agentSessionId) return externalBusy(s) === true;
    // opencode: a registered process has worked on it. Short of that, nobody can say
    if (s.agent === "opencode" && s.agentSessionId) {
      const id = s.agentSessionId;
      return opencodePeersOf(s).some((p) => p.sessions[id] !== undefined) ? true : null;
    }
    const entries = liveEntriesOf(s);
    if (entries === undefined || entries === null) return null;
    return entries.has(s.agentSessionId!);
  };
  // What that CLI is doing right now. Same registry read (and cache) as isCliLive, so the list's
  // "Running" and its "CLI" badge can never disagree about whether the process is there
  const cliState = (s: SessionRecord): LiveSessionEntry | null => liveEntriesOf(s)?.get(s.agentSessionId!) ?? null;

  // Live join (Step 2): everything the manager needs to hand a turn to the CLI process itself.
  // claude-peer.ts is the only module that knows how; here it is just wired to the profile's configDir
  const configDirOf = (s: SessionRecord): string | null => {
    try {
      return profileDir(paths.profilesDir, s.profile);
    } catch {
      return null;
    }
  };
  const peer: PeerBridge = {
    resolve: (s) => {
      const dir = configDirOf(s);
      return dir && s.agentSessionId ? resolvePeerTarget(dir, s.agentSessionId) : null;
    },
    status: (s, target) => {
      const dir = configDirOf(s);
      return dir ? readPeerStatus(dir, target) : null;
    },
    mode: (s, target) => {
      const dir = configDirOf(s);
      const file = dir && s.agentSessionId ? findTranscript(dir, s.cwd, s.agentSessionId) : null;
      // A session that has not run a turn yet has no transcript; its argv still says how it was started
      return (file ? readCliMode(file) : null) ?? readProcessMode(target.pid);
    },
    send: (s, target, frame) => {
      const dir = configDirOf(s);
      return sendPeerMessage(target, frame, dir ? readPeerToken(dir, target) : null);
    },
  };

  // Live join for Codex (Step 3 Wave 2): a message for a thread the CLI holds goes into that
  // thread's queue through codex-peer.ts, the only module that knows how. Same profile dir = CODEX_HOME
  const codexPeer: CodexPeerBridge = {
    queue: (s, msg) => {
      const dir = configDirOf(s);
      if (!dir || !s.agentSessionId) return Promise.reject(new Error("no codex home for this session"));
      return queueCodexMessage(dir, { threadId: s.agentSessionId, ...msg });
    },
    unqueue: (s, queuedSubmissionId) => {
      const dir = configDirOf(s);
      if (!dir || !s.agentSessionId) return Promise.reject(new Error("no codex home for this session"));
      return deleteCodexQueued(dir, { threadId: s.agentSessionId, queuedSubmissionId });
    },
  };

  // Live join for opencode: a message for a session the person's opencode can run goes to that
  // process through tiny's plugin; opencode-peer.ts is the only module that speaks to it
  const withPeer = <T>(t: OpencodeTarget, fn: (peer: OpencodePeer) => Promise<T>): Promise<T> => {
    const peer = readOpencodePeer(peersDir, t.pid);
    return peer ? fn(peer) : Promise.reject(new Error("the opencode CLI is gone"));
  };
  const opencodePeer: OpencodePeerBridge = {
    resolve: (s) => {
      if (!s.agentSessionId) return null;
      const peer = pickOpencodePeer(opencodePeersOf(s), s.cwd, s.agentSessionId);
      return peer ? { pid: peer.pid } : null;
    },
    state: (s, t) => {
      const peer = readOpencodePeer(peersDir, t.pid);
      if (!peer || !s.agentSessionId) return null;
      const id = s.agentSessionId;
      return {
        busy: peerSessionBusy(peer, id),
        idleAt: peerSessionIdleAt(peer, id),
        permissions: peer.permissions.filter((r) => r.root === id),
        questions: peer.questions.filter((q) => q.root === id),
      };
    },
    prompt: (s, t, msg) => withPeer(t, (peer) => opencodePeerPrompt(peer, { directory: s.cwd, sessionID: s.agentSessionId!, ...msg })),
    abort: (s, t) => withPeer(t, (peer) => opencodePeerAbort(peer, { directory: s.cwd, sessionID: s.agentSessionId! })),
    reply: (s, t, r) => withPeer(t, (peer) => opencodePeerReply(peer, { directory: s.cwd, ...r })),
  };

  let port = paths.port;
  const manager = new SessionManager({
    stores,
    profilesDir: paths.profilesDir,
    adapters: buildAdapters(),
    broker,
    outbox,
    // The `tiny mcp-server` spawned by the agent calls tinyd on the same Mac over loopback (port is finalized after listen)
    mcpLaunch: makeMcpLaunch({ serverUrl: () => `http://127.0.0.1:${port}` }),
    sessionTokens: auth,
    isCliLive,
    cliState,
    peer,
    codexPeer,
    opencodePeer,
    externalBusy,
    liveScanEnabled: (name) => readProfileLive(paths.profilesDir, name),
  });

  // Turns the previous tinyd was driving. Closed before push (or anyone) listens, so nothing is notified
  const recovered = manager.recoverAfterRestart();
  if (recovered > 0) console.log(`[tinyd] closed ${recovered} turn(s) left open by the previous tinyd`);

  // Settings are reloaded on every delivery, so `tiny push config` changes take effect without a restart.
  const push = new PushClient({ stores, settings: () => loadSettings(paths, env) });
  push.attach(manager);
  const settings = loadSettings(paths, env);
  console.log(
    settings.pushEnabled && settings.relayUrl !== ""
      ? `[tinyd] push enabled (relay: ${settings.relayUrl})`
      : "[tinyd] push disabled (enable it with `tiny push config --relay <url>`)",
  );

  // URL embedded in the pairing QR. Settings are reloaded on every call,
  // so `tiny config --server-url` changes take effect without a restart (same style as push)
  const serverUrl = () => {
    const { serverUrl: configured } = loadSettings(paths, env);
    return configured !== "" ? configured : `http://${os.hostname()}:${port}`;
  };
  const usage = new UsageService(paths.profilesDir);

  const app = createApp({
    manager, auth, outbox, profilesDir: paths.profilesDir, stores, serverUrl, push, usage, isCliLive,
  });
  const { injectWebSocket } = registerWs(app, { manager, auth, stores });

  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port: paths.port, hostname: "0.0.0.0" }, (info: AddressInfo) => {
      port = info.port;
      resolve(s);
    });
  });
  injectWebSocket(server);

  // Sessions the person starts in codex / opencode have no hook to announce them; watch the
  // agents' own storage instead (only profiles with `tiny live on`; the scan itself is date- and
  // table-bounded, see codex-live / opencode-live)
  const scanTimer = setInterval(() => {
    try {
      manager.scanExternalSessions();
    } catch (err) {
      console.error("[tinyd] external session scan failed:", err);
    }
    // A killed opencode leaves its plugin registration behind (a clean exit removes it)
    pruneOpencodePeers(peersDir);
  }, 5000);
  scanTimer.unref?.();

  return {
    port,
    url: `http://${os.hostname()}:${port}`,
    manager,
    auth,
    push,
    close: () =>
      new Promise<void>((resolve, reject) => {
        clearInterval(scanTimer);
        db.close();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
