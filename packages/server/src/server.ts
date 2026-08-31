import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { buildAdapters } from "./adapters.js";
import { ensureDirs, tinyPaths } from "./config.js";
import { createApp } from "./api.js";
import { AuthService } from "./auth.js";
import { readLiveSessionIds } from "./claude-live.js";
import { readCliMode, readPeerStatus, readPeerToken, resolvePeerTarget, sendPeerMessage } from "./claude-peer.js";
import { findTranscript } from "./claude-transcript.js";
import { FileOutbox } from "./outbox.js";
import { openDb } from "./db.js";
import { PermissionBroker } from "./permission-broker.js";
import { profileDir } from "./profiles.js";
import { PushClient } from "./push-client.js";
import { SessionManager } from "./session-manager.js";
import type { PeerBridge } from "./session-manager.js";
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
  const fixed = stores.sessions.fixupRunning();
  if (fixed > 0) console.log(`[tinyd] corrected ${fixed} running session(s) to interrupted`);

  const broker = new PermissionBroker();
  const outbox = new FileOutbox(paths.outboxDir, stores.files);
  const auth = new AuthService(stores, paths.secretFile);
  auth.cliToken(); // generate it on first startup
  // The session list polls every 4s and asks for every row, so read the registry at most once
  // per window instead of once per session
  const LIVE_TTL_MS = 2000;
  let liveCache: { at: number; byDir: Map<string, Set<string> | null> } | null = null;

  function liveIds(configDir: string): Set<string> | null {
    const now = Date.now();
    if (!liveCache || now - liveCache.at > LIVE_TTL_MS) liveCache = { at: now, byDir: new Map() };
    const cached = liveCache.byDir.get(configDir);
    if (cached !== undefined) return cached;
    const ids = readLiveSessionIds(configDir);
    liveCache.byDir.set(configDir, ids);
    return ids;
  }

  // Whether the agent's own CLI still holds a session. SessionManager uses it to refuse a turn that
  // would race the CLI, the API to report cliLive, so BOTH must get the same function
  const isCliLive = (s: SessionRecord): boolean | null => {
    if (s.agent !== "claude" || !s.agentSessionId) return null;
    let dir: string;
    try {
      dir = profileDir(paths.profilesDir, s.profile);
    } catch {
      return null; // a profile whose configDir vanished must not break the list
    }
    const ids = liveIds(dir);
    return ids === null ? null : ids.has(s.agentSessionId);
  };

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
    mode: (s) => {
      const dir = configDirOf(s);
      const file = dir && s.agentSessionId ? findTranscript(dir, s.cwd, s.agentSessionId) : null;
      return file ? readCliMode(file) : null;
    },
    send: (s, target, frame) => {
      const dir = configDirOf(s);
      return sendPeerMessage(target, frame, dir ? readPeerToken(dir, target) : null);
    },
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
    peer,
  });

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

  return {
    port,
    url: `http://${os.hostname()}:${port}`,
    manager,
    auth,
    push,
    close: () =>
      new Promise<void>((resolve, reject) => {
        db.close();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
