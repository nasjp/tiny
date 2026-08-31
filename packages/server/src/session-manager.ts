import crypto from "node:crypto";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import type { AgentAdapter, TurnImage } from "./adapter.js";
import type { McpLaunch } from "./mcp-launch.js";
import type { FileOutbox } from "./outbox.js";
import { profileDir, profileDriver } from "./profiles.js";
import { findTranscript, readTranscript, readTranscriptCursor } from "./claude-transcript.js";
import { PEER_STOP, wrapForPeer, type CliMode, type PeerFrame, type PeerStatus, type PeerTarget } from "./claude-peer.js";
import type { AgentCapabilities, AgentDriver } from "./agents/index.js";
import type { PendingPermission, PermissionBroker, PermissionDecision } from "./permission-broker.js";
import type { SessionPatch, Stores } from "./stores.js";
import type { FileRecord, PermissionModeValue, SessionRecord, SessionStatus } from "./types.js";

export class ConflictError extends Error {}
export class NotFoundError extends Error {}
/** Input is not among the agent's choices (400) */
export class ValidationError extends Error {}

/** Assert permissionMode / effort are among the profile's (agent's) choices */
function assertChoices(caps: AgentCapabilities, patch: { permissionMode?: string; effort?: string | null }): void {
  if (patch.permissionMode !== undefined && !caps.permissionModes.some((m) => m.id === patch.permissionMode)) {
    throw new ValidationError(
      `permissionMode "${patch.permissionMode}" is not available (choices: ${caps.permissionModes.map((m) => m.id).join(", ")})`,
    );
  }
  if (typeof patch.effort === "string" && caps.efforts.length > 0 && !caps.efforts.includes(patch.effort)) {
    throw new ValidationError(`effort "${patch.effort}" is not available (choices: ${caps.efforts.join(", ")})`);
  }
}

/** Per-turn session token issuer (implemented by AuthService). Configurations without it attach no MCP */
export interface SessionTokenIssuer {
  issueSessionToken(sessionId: string): string;
  revokeSessionTokens(sessionId: string): void;
}

/**
 * How the manager talks to the agent's own CLI process while it holds a session (Step 2 live join).
 * Implemented by claude-peer.ts in server.ts; tests inject fakes. Absent = Step 1 behaviour (409)
 */
export interface PeerBridge {
  /** The live CLI process holding this session, or null (= cannot join) */
  resolve: (s: SessionRecord) => PeerTarget | null;
  /** What that process is doing. null = it is gone */
  status: (s: SessionRecord, target: PeerTarget) => PeerStatus | null;
  /** The CLI's current permission mode, asserted on the wrapper so a bypass session delivers instead of holding */
  mode: (s: SessionRecord) => CliMode | null;
  send: (s: SessionRecord, target: PeerTarget, frame: PeerFrame) => Promise<void>;
}

export interface LiveTiming {
  /** How often the watcher looks at the transcript and the registry */
  pollMs: number;
  /** How long the CLI may sit idle without recording our message before we call it dropped */
  deliveryTimeoutMs: number;
  /** Hard stop for one live turn */
  maxTurnMs: number;
}

const DEFAULT_LIVE_TIMING: LiveTiming = { pollMs: 1000, deliveryTimeoutMs: 60_000, maxTurnMs: 30 * 60_000 };

export interface SessionManagerDeps {
  stores: Stores;
  profilesDir: string;
  /** Driver id -> adapter (`buildAdapters()`). A turn for an agent without one becomes turn_failed */
  adapters: Record<string, AgentAdapter>;
  broker: PermissionBroker;
  outbox: FileOutbox;
  /** Per-session/turn `tiny mcp-server` launch spec. Effective only together with sessionTokens */
  mcpLaunch?: (sessionId: string, token: string) => McpLaunch;
  /** Per-turn session token issuer. Without it, no MCP is attached to the adapter even if mcpLaunch exists (never falls back to the CLI token) */
  sessionTokens?: SessionTokenIssuer;
  /**
   * Whether the agent's own CLI still has this session open. null = cannot tell.
   * Injected so tests do not depend on a real registry. Absent = never blocks.
   */
  isCliLive?: (s: SessionRecord) => boolean | null;
  /** Live join into the CLI (Step 2). Absent = a turn sent while the CLI holds the session is refused (409) */
  peer?: PeerBridge;
  /** Watcher timings. Tests shorten them; production uses the defaults */
  liveTiming?: LiveTiming;
}

interface RunningTurn {
  abort: AbortController;
  done: Promise<void>;
}

interface LiveTurn {
  msgId: string;
  target: PeerTarget;
  startedAt: number;
  /** When the CLI's transcript first showed our msg_id */
  deliveredAt: number | null;
  /** The transcript produced assistant output after we started */
  sawResponse: boolean;
  /** Since when the CLI has been idle without having recorded our message (null while busy / delivered) */
  idleUndeliveredSince: number | null;
  lastStatus: PeerStatus["status"] | null;
  /** msg_id of the Stop message sent on interrupt(); the turn ends as "interrupted" once the CLI took it */
  stopMsgId: string | null;
}

export class SessionManager extends EventEmitter {
  private running = new Map<string, RunningTurn>();
  /** Turns currently running inside the user's CLI rather than tiny's own adapter, by session id */
  private liveTurns = new Map<string, LiveTurn>();
  /**
   * Last transcript stat per session. Parsing a transcript is expensive (a 139MB one costs ~250ms
   * and ~800MB of RSS) and the events endpoint asks on every poll, so an unchanged file must cost
   * one stat. Keyed on the resolved path too: findTranscript can fall back to scanning projects/,
   * so the file a session resolves to can change under us
   */
  private transcriptStats = new Map<string, { path: string; size: number; mtimeMs: number }>();

  constructor(private deps: SessionManagerDeps) {
    super();
  }

  private emitEvent(sessionId: string, type: string, payload: Record<string, unknown>): void {
    const ev = this.deps.stores.events.append(sessionId, type, payload);
    try {
      this.emit("event", ev);
    } catch (err) {
      console.error("[tinyd] event listener error:", err);
    }
  }

  /**
   * Shared entry validation for createSession / adoptSession: the profile exists, the requested
   * choices are among the agent's, and the cwd is a real directory.
   */
  private resolveProfile(input: {
    profile: string;
    cwd: string;
    permissionMode?: PermissionModeValue;
    effort?: string;
  }): { dir: string; driver: AgentDriver; caps: AgentCapabilities } {
    const dir = profileDir(this.deps.profilesDir, input.profile); // throws if missing
    const driver = profileDriver(this.deps.profilesDir, input.profile);
    const caps = driver.capabilities(dir);
    assertChoices(caps, input);
    if (!fs.existsSync(input.cwd) || !fs.statSync(input.cwd).isDirectory()) {
      throw new NotFoundError(`cwd not found: ${input.cwd}`);
    }
    return { dir, driver, caps };
  }

  createSession(input: {
    profile: string;
    cwd: string;
    permissionMode?: PermissionModeValue;
    model?: string;
    effort?: string;
  }): SessionRecord {
    const { driver, caps } = this.resolveProfile(input);
    const now = new Date().toISOString();
    const rec: SessionRecord = {
      id: crypto.randomUUID(),
      agentSessionId: null,
      agent: driver.id,
      profile: input.profile,
      cwd: input.cwd,
      // Default is the agent's first permission mode (default for claude, ask for opencode)
      permissionMode: input.permissionMode ?? caps.permissionModes[0]?.id ?? "default",
      model: input.model ?? null,
      effort: input.effort ?? null,
      title: null,
      status: "idle",
      archivedAt: null,
      sourceCursor: null,
      createdAt: now,
      updatedAt: now,
    };
    this.deps.stores.sessions.create(rec);
    return rec;
  }

  /**
   * How many human turns a first backfill imports. Counting records instead would fill the import
   * with tool traffic and almost none of the conversation the person came back for. Five turns is
   * 50-200 records on real transcripts, which stays clear of readTranscript's 300-record ceiling
   */
  private static readonly BACKFILL_TURNS = 5;

  /**
   * Register a session that was started in the agent's own CLI (`tiny handoff`).
   * Idempotent: SessionStart hooks fire again on resume / fork / clear.
   */
  adoptSession(input: {
    agent?: string;
    profile: string;
    cwd: string;
    agentSessionId: string;
    model?: string;
    effort?: string;
    permissionMode?: PermissionModeValue;
  }): { session: SessionRecord; adopted: boolean } {
    const { driver, caps } = this.resolveProfile(input);
    const existing = this.deps.stores.sessions.byAgentSessionId(input.agentSessionId);
    if (existing) {
      this.importOrSeed(existing.id);
      return { session: this.getSession(existing.id), adopted: false };
    }
    const now = new Date().toISOString();
    const rec: SessionRecord = {
      id: crypto.randomUUID(),
      agentSessionId: input.agentSessionId,
      agent: driver.id,
      profile: input.profile,
      cwd: input.cwd,
      permissionMode: input.permissionMode ?? caps.permissionModes[0]?.id ?? "default",
      model: input.model ?? null,
      effort: input.effort ?? null,
      title: null,
      status: "idle",
      archivedAt: null,
      sourceCursor: null,
      createdAt: now,
      updatedAt: now,
    };
    this.deps.stores.sessions.create(rec);
    this.importOrSeed(rec.id);
    return { session: this.getSession(rec.id), adopted: true };
  }

  /**
   * Import the CLI's transcript into a session — unless it already carries events but has no
   * cursor. Tiny and the CLI append to the SAME file, so importing there would replay turns tiny
   * already emitted natively (the phone would show the exchange twice). Seed the cursor instead,
   * so the import starts at the tail and only what the CLI writes from now on comes in.
   */
  private importOrSeed(id: string): void {
    const s = this.getSession(id);
    if (s.sourceCursor === null && this.deps.stores.events.count(id) > 0) {
      this.advanceCursor(s);
      return;
    }
    this.syncTranscript(id);
  }

  /**
   * Cursor bookkeeping on every exit path of a turn. Only for a session already tracking the CLI
   * transcript — a null cursor means nothing has been imported and importOrSeed will seed it later.
   */
  private advanceCursorAfterTurn(id: string): void {
    try {
      const s = this.deps.stores.sessions.get(id);
      if (s?.sourceCursor) this.advanceCursor(s);
    } catch {
      // bookkeeping must never mask the turn's own outcome (this runs in a finally)
    }
  }

  /**
   * Move the cursor to the transcript's current tail without emitting anything.
   * Never throws — an unreadable transcript just leaves the cursor where it is.
   */
  private advanceCursor(s: SessionRecord): void {
    try {
      const file = this.transcriptFile(s);
      if (!file) return;
      // Reads the same guard as syncTranscript — an unchanged file already has the cursor at its
      // tail, so there is nothing to do and no reason to parse it again — but NEVER records a stat.
      // Recording one here would mark the file consumed after reading nothing but its tail uuid,
      // and the next real sync would skip it, silently dropping genuine appended conversation.
      // Only the path that actually imports events may record a stat
      if (!this.transcriptChange(s.id, file)) return;
      const cursor = readTranscriptCursor(file);
      if (cursor && cursor !== s.sourceCursor) this.deps.stores.sessions.patch(s.id, { sourceCursor: cursor });
    } catch {
      // same non-throwing contract as syncTranscript: a missing transcript is normal
    }
  }

  /**
   * The transcript's stat when it is worth reading, or null when there is nothing new (path, size
   * and mtime all match the last read) or it cannot be stat'ed — both mean "do nothing".
   * Only a caller that goes on to IMPORT records the returned stat; see advanceCursor.
   */
  private transcriptChange(id: string, file: string): fs.Stats | null {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return null;
    }
    const seen = this.transcriptStats.get(id);
    // Any difference means read — a SMALLER file too, which is what a compact rewrite looks like
    if (seen && seen.path === file && seen.size === stat.size && seen.mtimeMs === stat.mtimeMs) return null;
    return stat;
  }

  /** The CLI transcript backing a session, or null when there is none (or the agent keeps no transcripts) */
  private transcriptFile(s: SessionRecord): string | null {
    if (!s.agentSessionId || s.agent !== "claude") return null;
    try {
      return findTranscript(profileDir(this.deps.profilesDir, s.profile), s.cwd, s.agentSessionId);
    } catch {
      return null; // the profile's config dir went away
    }
  }

  /**
   * Import transcript records written by the agent's own CLI since the last import.
   * Returns how many events were appended. Never throws — a missing transcript is normal.
   */
  syncTranscript(id: string): number {
    return this.importTranscript(id).imported;
  }

  private static readonly NO_IMPORT = { imported: 0, peerMsgIds: [] as string[], responded: false };

  private importTranscript(id: string): { imported: number; peerMsgIds: string[]; responded: boolean } {
    const s = this.getSession(id);
    // Mid-turn, tiny is itself appending to this transcript through the SDK and emitting every one
    // of those records natively as it goes. Importing them here would duplicate them, and the
    // cursor advance at completion cannot take back events already in the log. With this guard the
    // writers of the jsonl (the user's CLI, tiny's SDK child) and the writers of the cursor
    // (syncTranscript, turn completion) can no longer interleave.
    // A LIVE turn is the exception: the only writer is the user's CLI, so importing is the point
    if (s.status === "running" && !this.liveTurns.has(id)) return SessionManager.NO_IMPORT;
    const file = this.transcriptFile(s);
    if (!file) return SessionManager.NO_IMPORT;
    const stat = this.transcriptChange(id, file);
    if (!stat) return SessionManager.NO_IMPORT;
    const read = readTranscript(file, {
      sinceUuid: s.sourceCursor,
      ...(s.sourceCursor ? {} : { turns: SessionManager.BACKFILL_TURNS }),
    });
    for (const ev of read.events) this.emitEvent(id, ev.type, ev.payload);
    const patch: SessionPatch = {};
    if (read.cursor && read.cursor !== s.sourceCursor) patch.sourceCursor = read.cursor;
    if (read.title && !s.title) patch.title = read.title;
    if (Object.keys(patch).length > 0) this.deps.stores.sessions.patch(id, patch);
    // Commit the stat captured BEFORE the read — so an append that lands mid-read is picked up next
    // time rather than skipped — but only once the read has actually produced a cursor. A read that
    // yielded none (a rotate caught mid-flight) would otherwise advance the stat while the cursor
    // stood still, and those records would never be imported. Leave the old entry: the next call retries
    if (read.cursor) this.transcriptStats.set(id, { path: file, size: stat.size, mtimeMs: stat.mtimeMs });
    return {
      imported: read.events.length,
      peerMsgIds: read.peerMsgIds,
      responded: read.events.some((ev) => ev.type === "assistant_text" || ev.type === "tool_started"),
    };
  }

  /**
   * SessionEnd path: drop a handoff session that never got a single event.
   *
   * Import the transcript before judging. The SessionStart hook adopts a session before the user
   * has typed anything, so the backfill at adoption time imports nothing; if nothing syncs in
   * between, a session that ran a whole conversation still looks empty here and would be deleted.
   * After the import, "empty" means again what it was meant to mean: nothing ever happened.
   */
  discardIfEmpty(agentSessionId: string): boolean {
    const s = this.deps.stores.sessions.byAgentSessionId(agentSessionId);
    if (!s) return false;
    // syncTranscript declines to import while a turn is running. Deleting on the strength of a
    // look we did not take would be the same bug in a new place, so keep the session instead
    if (s.status === "running") return false;
    this.syncTranscript(s.id);
    if (this.deps.stores.events.count(s.id) > 0) return false;
    return this.deps.stores.sessions.delete(s.id);
  }

  /** Mid-session change of model / permission mode / archived. Does not affect a running turn; takes effect from the next turn */
  updateSession(
    id: string,
    patch: {
      model?: string | null;
      effort?: string | null;
      permissionMode?: PermissionModeValue;
      title?: string;
      archived?: boolean;
    },
  ): SessionRecord {
    const s = this.getSession(id);
    const { archived, ...rest } = patch;
    if (rest.permissionMode !== undefined || typeof rest.effort === "string") {
      const driver = profileDriver(this.deps.profilesDir, s.profile);
      assertChoices(driver.capabilities(profileDir(this.deps.profilesDir, s.profile)), rest);
    }
    const storePatch: SessionPatch = { ...rest };
    if (archived === true) {
      // Letting a running or CLI-attached conversation disappear from the list invites accidents
      if (s.status === "running" || s.status === "detached") {
        throw new ConflictError(`cannot archive a ${s.status} session`);
      }
      storePatch.archivedAt = new Date().toISOString();
    } else if (archived === false) {
      storePatch.archivedAt = null;
    }
    this.deps.stores.sessions.patch(id, storePatch);
    return this.getSession(id);
  }

  listSessions(status?: SessionStatus, archived = false): SessionRecord[] {
    return this.deps.stores.sessions.list(status, archived);
  }

  /** cwd candidates for New Session. Restricted to directories that still exist on the Mac (deleted repos drop out naturally) */
  listRecentCwds(limit = 30): string[] {
    return this.deps.stores.sessions.recentCwds()
      .filter((cwd) => fs.existsSync(cwd) && fs.statSync(cwd).isDirectory())
      .slice(0, limit);
  }

  getSession(id: string): SessionRecord {
    const s = this.deps.stores.sessions.get(id);
    if (!s) throw new NotFoundError(`session not found: ${id}`);
    return s;
  }

  /**
   * Whether a turn sent now would run inside the user's CLI (live join) rather than be refused.
   * Claude only in Step 2; other agents keep the Step 1 rule
   */
  canJoin(s: SessionRecord): boolean {
    if (!this.deps.peer || s.agent !== "claude" || !s.agentSessionId) return false;
    if (this.deps.isCliLive?.(s) !== true) return false;
    return this.deps.peer.resolve(s) !== null;
  }

  startTurn(id: string, prompt: string, images?: TurnImage[]): void {
    const s = this.getSession(id);
    if (s.status === "running") throw new ConflictError("turn already running");
    if (s.status === "detached") throw new ConflictError("session is attached from CLI");
    if (this.deps.isCliLive?.(s) === true) {
      // The CLI holds the session. Running the turn in a second process would race it on the
      // transcript, so either hand the message to that very process (live join) or refuse
      const target = this.canJoin(s) ? this.deps.peer!.resolve(s) : null;
      if (!target) throw new ConflictError("session is open in the CLI");
      this.deps.stores.sessions.patch(id, { status: "running", title: s.title ?? prompt.slice(0, 60) });
      const saved = this.persistUserMessage(id, prompt, images);
      const done = this.runLiveTurn(s, prompt, saved.paths, target).finally(() => this.running.delete(id));
      this.running.set(id, { abort: new AbortController(), done });
      return;
    }
    const abort = new AbortController();
    this.deps.stores.sessions.patch(id, { status: "running", title: s.title ?? prompt.slice(0, 60) });
    this.persistUserMessage(id, prompt, images);
    const done = this.runTurn(s, prompt, images, abort.signal).finally(() => this.running.delete(id));
    this.running.set(id, { abort, done });
  }

  /**
   * Persist the user's message as an event. Without this, the client's history view shows no
   * user-side bubbles at all (the SDK stream does not include the prompt). Images are saved to the
   * outbox and given a fileId (so history can show thumbnails); a save failure must not block the
   * send itself (only the image count remains in that case)
   */
  private persistUserMessage(id: string, prompt: string, images?: TurnImage[]): { fileIds: string[]; paths: string[] } {
    let fileIds: string[] = [];
    let paths: string[] = [];
    try {
      const saved = (images ?? []).map((img) => this.deps.outbox.saveData(id, Buffer.from(img.data, "base64"), img.mediaType));
      fileIds = saved.map((f) => f.id);
      paths = saved.map((f) => f.storedPath);
    } catch (err) {
      console.error("[tinyd] failed to persist turn images:", err);
      fileIds = [];
      paths = [];
    }
    this.emitEvent(id, "user_message", {
      text: prompt,
      ...(images && images.length > 0 ? { imageCount: images.length } : {}),
      ...(fileIds.length > 0 ? { imageFileIds: fileIds } : {}),
    });
    return { fileIds, paths };
  }

  private async runTurn(
    s: SessionRecord,
    prompt: string,
    images: TurnImage[] | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    // The send_user_file token is valid for this turn only. Always revoke it on finish (success / failure / interrupt)
    const mcpToken =
      this.deps.sessionTokens && this.deps.mcpLaunch ? this.deps.sessionTokens.issueSessionToken(s.id) : null;
    try {
      const adapter = this.deps.adapters[s.agent];
      if (!adapter) throw new Error(`no adapter for agent "${s.agent}" (is it registered in src/adapters.ts?)`);
      const result = await adapter.runTurn({
        agentSessionId: s.agentSessionId,
        profileDir: profileDir(this.deps.profilesDir, s.profile),
        cwd: s.cwd,
        permissionMode: s.permissionMode,
        model: s.model,
        effort: s.effort,
        tinySessionId: s.id,
        prompt,
        ...(images && images.length > 0 ? { images } : {}),
        emit: (ev) => this.emitEvent(s.id, ev.type, ev.payload),
        requestPermission: async (toolName, input, hint) => {
          const { id: reqId, decision } = this.deps.broker.request(s.id, toolName, input, hint);
          this.emitEvent(s.id, "permission_requested", {
            reqId,
            toolName,
            input: input as Record<string, unknown>,
            ...(hint ? { kind: hint.kind, summary: hint.summary } : {}),
          });
          const d = await decision;
          // Keep AskUserQuestion answers (updatedInput.answers) in the history.
          // Without this, the client's history never shows what the user chose
          const answers =
            d.behavior === "allow" && d.updatedInput && typeof d.updatedInput.answers === "object"
              ? (d.updatedInput.answers as Record<string, unknown>)
              : undefined;
          this.emitEvent(s.id, "permission_resolved", {
            reqId,
            behavior: d.behavior,
            ...(answers ? { answers } : {}),
          });
          return d;
        },
        mcpServer: mcpToken && this.deps.mcpLaunch ? this.deps.mcpLaunch(s.id, mcpToken) : null,
        signal,
      });
      this.deps.stores.sessions.patch(s.id, { status: "idle", agentSessionId: result.agentSessionId });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      // A throw while interrupting means the adapter was still starting up (session/new, load, thread/start, ...).
      // Normalize the per-agent wording ("Cursor session/load failed: ... interrupted before the turn started" etc.)
      // so the app and push see the same "interrupted" as any other interrupt
      const message = signal.aborted ? "interrupted" : raw;
      if (signal.aborted && raw !== "interrupted") console.error(`[tinyd] turn interrupted during startup: ${raw}`);
      // Spec: expired auth is emitted as auth_error (becomes a push target in Phase 2)
      const type = !signal.aborted && /login|auth|credential|oauth|api key/i.test(raw) ? "auth_error" : "turn_failed";
      this.emitEvent(s.id, type, { error: message });
      this.deps.stores.sessions.patch(s.id, { status: "idle" });
    } finally {
      // This turn appended to the same transcript the user's CLI writes, and every one of those
      // records was already emitted natively above. Skip past them so a later sync cannot replay
      // them — on the failure and interrupt paths too, where the transcript already holds the
      // prompt and a partial response. Runs after both status patches, so the running guard in
      // syncTranscript is lifted by the time anything reads the cursor
      this.advanceCursorAfterTurn(s.id);
      if (mcpToken) this.deps.sessionTokens!.revokeSessionTokens(s.id);
    }
  }

  /**
   * A turn that runs inside the user's CLI. We hand the message to the CLI process over its
   * messaging socket, then watch two things it maintains anyway: the transcript (for our msg_id
   * coming back as a peer record, and for the reply) and the registry status (busy / idle /
   * waiting). Nothing in this loop touches the socket again — the CLI never answers on it
   */
  private async runLiveTurn(s: SessionRecord, prompt: string, imagePaths: string[], target: PeerTarget): Promise<void> {
    const timing = this.deps.liveTiming ?? DEFAULT_LIVE_TIMING;
    const live: LiveTurn = {
      msgId: crypto.randomUUID(), target, startedAt: Date.now(), deliveredAt: null,
      sawResponse: false, idleUndeliveredSince: null, lastStatus: null, stopMsgId: null,
    };
    this.liveTurns.set(s.id, live);
    try {
      // The CLI's inbox takes text only; images go on disk where the CLI can Read them
      const body = prompt + imagePaths.map((p) => `\n[attached image: ${p}]`).join("");
      const content = wrapForPeer(body, { name: "tiny", mode: this.deps.peer!.mode(s) });
      try {
        await this.deps.peer!.send(s, target, { agentSessionId: s.agentSessionId!, msgId: live.msgId, content, priority: "next" });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.emitEvent(s.id, "turn_failed", { error: `could not reach the CLI: ${reason}` });
        return;
      }
      this.emitEvent(s.id, "turn_started", { agentSessionId: s.agentSessionId });
      for (;;) {
        await new Promise((r) => setTimeout(r, timing.pollMs));
        const outcome = this.pollLiveTurn(s, live, timing);
        if (outcome) {
          this.emitEvent(s.id, outcome.type, outcome.payload);
          return;
        }
      }
    } finally {
      this.liveTurns.delete(s.id);
      this.deps.stores.sessions.patch(s.id, { status: "idle" });
      // No advanceCursorAfterTurn here: everything the CLI wrote is ours to import
    }
  }

  /** One watcher tick. Returns the terminal event when the turn is over, null to keep watching */
  private pollLiveTurn(
    s: SessionRecord,
    live: LiveTurn,
    timing: LiveTiming,
  ): { type: "turn_completed" | "turn_failed"; payload: Record<string, unknown> } | null {
    const now = Date.now();
    const read = this.importTranscript(s.id);
    if (live.deliveredAt === null && read.peerMsgIds.includes(live.msgId)) live.deliveredAt = now;
    if (read.responded) live.sawResponse = true;

    const st = this.deps.peer!.status(s, live.target);
    if (st === null) return { type: "turn_failed", payload: { error: "the CLI closed" } };
    if (st.status === "waiting" && live.lastStatus !== "waiting") {
      this.emitEvent(s.id, "cli_attention", { reason: st.waitingFor ?? "input" });
    }
    live.lastStatus = st.status;

    // Stop was tapped: the CLI abandoned our turn for the stop message; once it took that and went
    // quiet, the turn is over. "interrupted" is what the SDK path reports too, so the app shows Stopped
    if (live.stopMsgId !== null && read.peerMsgIds.includes(live.stopMsgId)) live.deliveredAt ??= now;
    if (live.stopMsgId !== null && live.deliveredAt !== null && st.status === "idle") {
      return { type: "turn_failed", payload: { error: "interrupted" } };
    }
    if (live.deliveredAt !== null && live.sawResponse && st.status === "idle") {
      return { type: "turn_completed", payload: { costUsd: null, resultText: null } };
    }
    // Only idle time counts against delivery: while the CLI is busy with its own turn our message
    // sits in its queue, and that can legitimately take minutes
    if (live.deliveredAt === null && st.status === "idle") {
      live.idleUndeliveredSince ??= now;
      if (now - live.idleUndeliveredSince > timing.deliveryTimeoutMs) {
        return {
          type: "turn_failed",
          payload: { error: "the CLI dropped the message (it drops a repeat of the previous message within 30s, rate-limits bursts, and holds messages it was told to review)" },
        };
      }
    } else {
      live.idleUndeliveredSince = null;
    }
    if (now - live.startedAt > timing.maxTurnMs) {
      return { type: "turn_failed", payload: { error: `no response from the CLI in ${Math.round(timing.maxTurnMs / 60_000)} minutes` } };
    }
    return null;
  }

  /** Save an agent-sent file to the outbox and record file_sent (the `tiny mcp-server` -> POST /files path) */
  saveUserFile(sessionId: string, filePath: string, caption?: string): FileRecord {
    this.getSession(sessionId); // NotFoundError if missing
    const rec = this.deps.outbox.save(sessionId, filePath, caption);
    this.emitEvent(sessionId, "file_sent", { fileId: rec.id, mime: rec.mime, caption: rec.caption, name: rec.originalPath });
    return rec;
  }

  async waitForIdle(id: string): Promise<void> {
    await this.running.get(id)?.done;
  }

  interrupt(id: string): void {
    const s = this.getSession(id);
    const live = this.liveTurns.get(id);
    if (!live) {
      this.running.get(id)?.abort.abort();
      return;
    }
    // The CLI owns this turn and its socket has no cancel — but a "now" message makes it abandon
    // what it is doing and take that message instead (measured). Send the stop note that way;
    // the watcher closes the turn as "interrupted" once the CLI has taken it
    if (live.stopMsgId !== null) return; // already stopping
    live.stopMsgId = crypto.randomUUID();
    const content = wrapForPeer(PEER_STOP, { name: "tiny", mode: this.deps.peer!.mode(s) });
    this.deps.peer!
      .send(s, live.target, { agentSessionId: s.agentSessionId!, msgId: live.stopMsgId, content, priority: "now" })
      .catch((err) => {
        live.stopMsgId = null; // let a later tap try again
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[tinyd] could not send stop to the CLI: ${reason}`);
      });
  }

  setDetached(id: string, detached: boolean): SessionRecord {
    const s = this.getSession(id);
    if (detached && s.status === "running") throw new ConflictError("turn running");
    this.deps.stores.sessions.patch(id, { status: detached ? "detached" : "idle" });
    this.emitEvent(id, "session_state_changed", { status: detached ? "detached" : "idle" });
    return this.getSession(id);
  }

  resolvePermission(reqId: string, d: PermissionDecision): boolean {
    return this.deps.broker.resolve(reqId, d);
  }

  listPendingPermissions(sessionId: string): PendingPermission[] {
    return this.deps.broker.listPending(sessionId);
  }
}
