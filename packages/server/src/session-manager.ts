import crypto from "node:crypto";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import type { AgentAdapter, TurnImage } from "./adapter.js";
import type { McpLaunch } from "./mcp-launch.js";
import type { FileOutbox } from "./outbox.js";
import { listProfiles, profileDir, profileDriver } from "./profiles.js";
import type { LiveSessionEntry } from "./claude-live.js";
import type { ExternalTurn } from "./agent-storage.js";
import { codexRolloutCursor, findCodexRollout, listCodexSessions, readCodexRollout } from "./codex-live.js";
import { listOpencodeSessions, opencodeDbStat, opencodeSessionCursor, readOpencodeSession } from "./opencode-live.js";
import { findTranscript, readTranscript, readTranscriptCursor, type TranscriptTurn } from "./claude-transcript.js";
import { PEER_STOP, wrapForPeer, type CliMode, type PeerFrame, type PeerStatus, type PeerTarget } from "./claude-peer.js";
import type { AgentCapabilities, AgentDriver } from "./agents/index.js";
import type { PendingPermission, PermissionBroker, PermissionDecision } from "./permission-broker.js";
import type { SessionPatch, Stores } from "./stores.js";
import type { FileRecord, PermissionModeValue, SessionRecord, SessionStatus, SessionActivity } from "./types.js";

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
  mode: (s: SessionRecord, target: PeerTarget) => CliMode | null;
  send: (s: SessionRecord, target: PeerTarget, frame: PeerFrame) => Promise<void>;
}

export interface LiveTiming {
  /** How often the watcher looks at the transcript and the registry */
  pollMs: number;
  /** How long the CLI may sit idle without recording our message before we call it dropped */
  deliveryTimeoutMs: number;
  /**
   * How long the CLI may sit idle after recording our message before that idle counts as the turn
   * being over, when neither a reply nor the registry's own clock has said so yet
   */
  idleSettleMs: number;
}

// No overall cap: a CLI that is busy is working, however long it takes, and the registry (plus the
// process itself) is what says when it is not. Every way a turn can end is evidence-based
const DEFAULT_LIVE_TIMING: LiveTiming = { pollMs: 1000, deliveryTimeoutMs: 60_000, idleSettleMs: 5000 };

/** The SDK's child `claude` stays in the registry a moment after the result arrives */
const OWN_PROCESS_GRACE_MS = 10_000;

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
  /**
   * What the CLI process holding this session is doing (registry status). null = not open or cannot
   * tell. Feeds `activity` for turns the person typed into the terminal, which tiny never sees start
   */
  cliState?: (s: SessionRecord) => LiveSessionEntry | null;
  /**
   * Whether `tiny live` scanning is on for a hookless profile (codex / opencode): tinyd then
   * adopts sessions the person starts in the agent's own CLI by watching its storage
   */
  liveScanEnabled?: (profileName: string) => boolean;
  /**
   * Process-level evidence that the agent's own CLI is working a session right now (codex thread
   * lock holders, opencode instance pids). false = definitely nobody; null = cannot tell
   */
  externalBusy?: (s: SessionRecord) => boolean | null;
  /** Live join into the CLI (Step 2). Absent = a turn sent while the CLI holds the session is refused (409) */
  peer?: PeerBridge;
  /** Watcher timings. Tests shorten them; production uses the defaults */
  liveTiming?: LiveTiming;
  /**
   * How long after tiny's own SDK turn ends its child process may still show in the registry.
   * Tests shorten it; production uses OWN_PROCESS_GRACE_MS
   */
  ownProcessGraceMs?: number;
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
  /** The transcript produced assistant output after we started (only counted once deliveredAt is set) */
  sawResponse: boolean;
  /** Since when the CLI has been idle without having recorded our message (null while busy / delivered) */
  idleUndeliveredSince: number | null;
  /** Since when the CLI has been idle after recording our message (null while busy / undelivered) */
  idleDeliveredSince: number | null;
  /** Since when the registry entry has been unreadable (null while it reads) */
  unknownSince: number | null;
  lastStatus: PeerStatus["status"] | null;
  /** msg_id of the Stop message sent on interrupt(); the turn ends as "interrupted" once the CLI took it */
  stopMsgId: string | null;
  /** When the CLI's transcript first showed the Stop message's own msg_id */
  stopDeliveredAt: number | null;
  /** Why the Stop message could not be handed over. Set here, turned into the terminal event by the watcher */
  stopFailure: string | null;
  /** Newest assistant text imported during this turn; goes out as turn_completed's resultText (what the push shows) */
  lastAssistantText: string | null;
}

/**
 * Registry statuses that mean "work is in progress over there": a turn (busy), a permission prompt
 * mid-turn (waiting), or a background shell task the CLI is waiting on after its turn ended (shell —
 * measured: a `!cmd` typed at the prompt reads busy, not shell). The CLI resumes when that task exits
 */
const CLI_BUSY: ReadonlySet<string> = new Set(["busy", "waiting", "shell"]);

/**
 * How one frame goes down the CLI's messaging socket. `question` marks it as the answer to an
 * AskUserQuestion the CLI is showing: it is not a message the person typed, and it must arrive with
 * priority "now" — a queued frame would sit behind the very prompt it is meant to answer
 */
interface LiveSend {
  priority: "next" | "now";
  question?: { toolUseId: string; answers: Record<string, string> };
}

/** A message waiting for the running turn to end. Already in the conversation when it gets here */
interface QueuedTurn {
  prompt: string;
  images?: TurnImage[];
  /** Outbox paths of the attachments, for a live turn to point the CLI at */
  paths: string[];
}

export class SessionManager extends EventEmitter {
  private running = new Map<string, RunningTurn>();
  /** Progress of the turns in `running`: when they started and, for adapters that report it, output so far */
  private turnProgress = new Map<string, { since: string; outputTokens: number | null }>();
  /** Newest turn seen in each session's transcript / storage at the last import, and when that ran */
  private transcriptTurns = new Map<string, TranscriptTurn & { readAt: number; open?: boolean }>();
  /** Rollout file per codex session, found once (the date-dir scan is not free) */
  private codexRollouts = new Map<string, string>();
  /** Turns currently running inside the user's CLI rather than tiny's own adapter, by session id */
  private liveTurns = new Map<string, LiveTurn>();
  /**
   * Messages that arrived while a turn was running, in order. Typing during a turn queues in
   * Claude Code's own CLI, so it queues here too — refusing them made the phone the odd one out.
   * The message is already in the conversation when it lands here (persisted at queue time), so
   * what is kept is only what running it later needs
   */
  private queued = new Map<string, QueuedTurn[]>();
  /**
   * Last transcript stat per session. Parsing a transcript is expensive (a 139MB one costs ~250ms
   * and ~800MB of RSS) and the events endpoint asks on every poll, so an unchanged file must cost
   * one stat. Keyed on the resolved path too: findTranscript can fall back to scanning projects/,
   * so the file a session resolves to can change under us
   */
  private transcriptStats = new Map<string, { path: string; size: number; mtimeMs: number }>();
  /**
   * AskUserQuestion calls answered from the phone, by session. Delivering an answer cancels the
   * CLI's own question prompt, so the transcript then records the call as rejected — that echo is
   * dropped here, otherwise the answer card would be followed by "Dismissed in the CLI"
   */
  private phoneAnswered = new Map<string, Set<string>>();
  /**
   * Questions the CLI has asked and not yet resolved, by session. The transcript reader needs them
   * to recognise a dismissed question: the tool_result of a dismissed AskUserQuestion looks like any
   * other rejection, and the question that named the id was imported in an earlier read
   */
  private openQuestions = new Map<string, Set<string>>();
  /**
   * Every question already in a session's history, by session. The PreToolUse hook announces a
   * question the moment it is asked; the same question turns up in the transcript later, and only
   * one of the two may become an event
   */
  private seenQuestions = new Map<string, Set<string>>();
  /**
   * Registry-side evidence for "the CLI closed this session". seen = the pid last observed holding
   * the session; closed = the pid that closed it, so a process still shutting down after the
   * SessionEnd hook fired is not taken for a reopen. Memory only: after a restart the hook is the signal
   */
  private cliSeenPid = new Map<string, number>();
  private cliClosedPid = new Map<string, number>();
  /**
   * tiny's own SDK turns per session: their child `claude` registers like any CLI (measured on
   * 2.1.258), so a registry entry started after one of these — while it runs or shortly after —
   * is ours and says nothing about the person's terminal
   */
  private ownSdkTurn = new Map<string, { startedAt: number; endedAt: number | null }>();

  constructor(private deps: SessionManagerDeps) {
    super();
  }

  private emitEvent(sessionId: string, type: string, payload: Record<string, unknown>): void {
    if (type === "cli_question" || type === "cli_question_answered") {
      const ids = this.openQuestionIds(sessionId);
      const toolUseId = typeof payload.toolUseId === "string" ? payload.toolUseId : "";
      if (type === "cli_question") {
        ids.add(toolUseId);
        this.seenQuestions.get(sessionId)?.add(toolUseId);
      } else {
        ids.delete(toolUseId);
      }
    }
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

  /**
   * `announce` = the session appeared from the Mac side (`tiny new`), so listeners such as the
   * push client tell the phone about it. The phone's own creations are never announced back to it
   */
  createSession(input: {
    profile: string;
    cwd: string;
    permissionMode?: PermissionModeValue;
    model?: string;
    effort?: string;
  }, opts: { announce?: boolean } = {}): SessionRecord {
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
      cliClosedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.deps.stores.sessions.create(rec);
    if (opts.announce) this.announce(rec);
    return rec;
  }

  /** Never lets a listener's failure reach the caller that created the session */
  private announce(s: SessionRecord): void {
    try {
      this.emit("session_added", s);
    } catch (err) {
      console.error("[tinyd] session_added listener error:", err);
    }
  }

  /**
   * How many human turns a first backfill imports. Counting records instead would fill the import
   * with tool traffic and almost none of the conversation the person came back for. Five turns is
   * 50-200 records on real transcripts, which stays clear of readTranscript's 300-record ceiling
   */
  private static readonly BACKFILL_TURNS = 5;

  /** A phone can send faster than turns finish; a queue nobody can see the end of is not a feature */
  static readonly MAX_QUEUED = 10;

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
      // The CLI opened it again (SessionStart fires on resume): no longer closed
      if (existing.cliClosedAt !== null) this.clearCliClosed(existing.id);
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
      cliClosedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.deps.stores.sessions.create(rec);
    this.importOrSeed(rec.id);
    // Always from the Mac side (a hook or `tiny handoff`), and only the first time: the hook fires
    // again on resume / fork / clear, which is not a new session
    this.announce(rec);
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
      if (s.agent === "codex") {
        const file = this.codexRollout(s);
        const cursor = file ? codexRolloutCursor(file) : null;
        if (cursor && cursor !== s.sourceCursor) this.deps.stores.sessions.patch(s.id, { sourceCursor: cursor });
        return;
      }
      if (s.agent === "opencode") {
        if (!s.agentSessionId) return;
        const cursor = opencodeSessionCursor(profileDir(this.deps.profilesDir, s.profile), s.agentSessionId);
        // null = the tail is an unfinished reply; leaving the cursor lets the next sync take it whole
        if (cursor !== null && cursor !== "" && cursor !== s.sourceCursor) {
          this.deps.stores.sessions.patch(s.id, { sourceCursor: cursor });
        }
        return;
      }
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

  private static noImport(): { imported: number; peerMsgIds: string[]; responded: boolean } {
    return { imported: 0, peerMsgIds: [], responded: false };
  }

  private importTranscript(id: string): { imported: number; peerMsgIds: string[]; responded: boolean } {
    const s = this.getSession(id);
    if (s.agent === "codex" || s.agent === "opencode") {
      // Same running guard as claude, minus live turns (those are claude-only)
      if (this.running.has(id)) return SessionManager.noImport();
      try {
        return s.agent === "codex" ? this.importCodex(s) : this.importOpencode(s);
      } catch {
        return SessionManager.noImport(); // a vanished profile dir etc.; never throw out of a sync
      }
    }
    // Mid-turn, tiny is itself appending to this transcript through the SDK and emitting every one
    // of those records natively as it goes. Importing them here would duplicate them, and the
    // cursor advance at completion cannot take back events already in the log. With this guard the
    // writers of the jsonl (the user's CLI, tiny's SDK child) and the writers of the cursor
    // (syncTranscript, turn completion) can no longer interleave.
    // A LIVE turn is the exception: the only writer is the user's CLI, so importing is the point
    // Keyed on the turn actually in flight, not on the stored status: a status left behind by a
    // killed daemon would otherwise stop the transcript from ever being imported again
    if (this.running.has(id) && !this.liveTurns.has(id)) return SessionManager.noImport();
    const file = this.transcriptFile(s);
    if (!file) return SessionManager.noImport();
    const stat = this.transcriptChange(id, file);
    if (!stat) return SessionManager.noImport();
    const read = readTranscript(file, {
      // Questions from earlier reads: their tool_result is an answer (or a dismissal), not a tool finishing
      openQuestions: this.openQuestionIds(id),
      sinceUuid: s.sourceCursor,
      ...(s.sourceCursor ? {} : { turns: SessionManager.BACKFILL_TURNS }),
    });
    for (const ev of read.events) {
      if (this.isRejectedEcho(id, ev) || this.isKnownQuestion(id, ev)) continue;
      this.emitEvent(id, ev.type, ev.payload);
    }
    if (read.turn) this.transcriptTurns.set(id, { ...read.turn, readAt: Date.now() });
    const patch: SessionPatch = {};
    if (read.cursor && read.cursor !== s.sourceCursor) patch.sourceCursor = read.cursor;
    if (read.title && !s.title) patch.title = read.title;
    if (Object.keys(patch).length > 0) this.deps.stores.sessions.patch(id, patch);
    // Commit the stat captured BEFORE the read — so an append that lands mid-read is picked up next
    // time rather than skipped — but only once the read has actually produced a cursor. A read that
    // yielded none (a rotate caught mid-flight) would otherwise advance the stat while the cursor
    // stood still, and those records would never be imported. Leave the old entry: the next call retries
    if (read.cursor) this.transcriptStats.set(id, { path: file, size: stat.size, mtimeMs: stat.mtimeMs });
    const responded = read.events.some(
      (ev) =>
        ev.type === "assistant_text" || ev.type === "assistant_thinking" || ev.type === "tool_started" ||
        // A question back to the person is a response too — without it a turn answered only by
        // AskUserQuestion would look like the CLI never took our message
        ev.type === "cli_question",
    );
    // Record delivery/response evidence directly on the live turn (if any), not just in the return
    // value: this call can come from a live turn's own watcher tick OR from any other caller of
    // syncTranscript (e.g. GET /v1/sessions/:id/events, polled whenever the phone has the chat
    // open). Whoever gets here first must not steal the evidence from the other
    const live = this.liveTurns.get(id);
    if (live) {
      if (live.deliveredAt === null && read.peerMsgIds.includes(live.msgId)) live.deliveredAt = Date.now();
      if (live.stopMsgId !== null && live.stopDeliveredAt === null && read.peerMsgIds.includes(live.stopMsgId)) {
        live.stopDeliveredAt = Date.now();
      }
      // Only count output produced after (or in the same read as) our message landing — otherwise a
      // backfill of an earlier turn, or the CLI's own concurrent turn, would latch a response that
      // was never ours
      if (live.deliveredAt !== null && responded) live.sawResponse = true;
      // Keep the newest reply text: turn_completed carries it to the phone, and the push notification
      // has nothing else to show (the SDK's own result text does not exist on this path). Gated on
      // delivery exactly like sawResponse — text from before our message landed belongs to the CLI's
      // own concurrent turn, and a reply of ours made purely of tool use would otherwise inherit it
      if (live.deliveredAt !== null) {
        for (const ev of read.events) {
          if (ev.type === "assistant_text" && typeof ev.payload.text === "string") live.lastAssistantText = ev.payload.text;
        }
      }
    }
    return { imported: read.events.length, peerMsgIds: read.peerMsgIds, responded };
  }

  /** The rollout file backing a codex session, found once and cached while it exists */
  private codexRollout(s: SessionRecord): string | null {
    const cached = this.codexRollouts.get(s.id);
    if (cached && fs.existsSync(cached)) return cached;
    if (!s.agentSessionId) return null;
    const file = findCodexRollout(profileDir(this.deps.profilesDir, s.profile), s.agentSessionId);
    if (file) this.codexRollouts.set(s.id, file);
    return file;
  }

  /**
   * The importOrSeed rule, applied inline on every sync: a session whose events were emitted
   * natively (turns tiny ran) but whose cursor was never seeded must NOT import its storage from
   * zero — that would replay the whole conversation. Seed at the tail instead.
   */
  private seedInsteadOfImport(s: SessionRecord, tailCursor: () => string | null): boolean {
    if (s.sourceCursor !== null || this.deps.stores.events.count(s.id) === 0) return false;
    const cursor = tailCursor();
    if (cursor !== null && cursor !== "") this.deps.stores.sessions.patch(s.id, { sourceCursor: cursor });
    return true;
  }

  /** What the newest read said about the turn in progress. startedAt null inherits the previous read's */
  private recordExternalTurn(id: string, turn: ExternalTurn | null): void {
    if (!turn) return;
    const prev = this.transcriptTurns.get(id);
    this.transcriptTurns.set(id, {
      startedAt: turn.startedAt ?? prev?.startedAt ?? null,
      outputTokens: turn.outputTokens ?? (turn.open ? prev?.outputTokens ?? 0 : 0),
      open: turn.open,
      readAt: Date.now(),
    });
  }

  private importCodex(s: SessionRecord): { imported: number; peerMsgIds: string[]; responded: boolean } {
    const file = this.codexRollout(s);
    if (!file) return SessionManager.noImport();
    if (this.seedInsteadOfImport(s, () => codexRolloutCursor(file))) return SessionManager.noImport();
    const stat = this.transcriptChange(s.id, file);
    if (!stat) return SessionManager.noImport();
    const read = readCodexRollout(file, s.sourceCursor);
    if (!read) return SessionManager.noImport();
    for (const ev of read.events) this.emitEvent(s.id, ev.type, ev.payload);
    this.recordExternalTurn(s.id, read.turn);
    const patch: SessionPatch = {};
    if (read.cursor !== s.sourceCursor) patch.sourceCursor = read.cursor;
    if (read.title && !s.title) patch.title = read.title;
    if (Object.keys(patch).length > 0) this.deps.stores.sessions.patch(s.id, patch);
    this.transcriptStats.set(s.id, { path: file, size: stat.size, mtimeMs: stat.mtimeMs });
    return { imported: read.events.length, peerMsgIds: [], responded: false };
  }

  private importOpencode(s: SessionRecord): { imported: number; peerMsgIds: string[]; responded: boolean } {
    if (!s.agentSessionId) return SessionManager.noImport();
    const dir = profileDir(this.deps.profilesDir, s.profile);
    if (this.seedInsteadOfImport(s, () => opencodeSessionCursor(dir, s.agentSessionId!))) return SessionManager.noImport();
    const st = opencodeDbStat(dir);
    if (!st) return SessionManager.noImport();
    const seen = this.transcriptStats.get(s.id);
    if (seen && seen.size === st.size && seen.mtimeMs === st.mtimeMs) return SessionManager.noImport();
    const read = readOpencodeSession(dir, s.agentSessionId, s.sourceCursor);
    if (!read) return SessionManager.noImport();
    for (const ev of read.events) this.emitEvent(s.id, ev.type, ev.payload);
    this.recordExternalTurn(s.id, read.turn);
    const patch: SessionPatch = {};
    if (read.cursor !== "" && read.cursor !== s.sourceCursor) patch.sourceCursor = read.cursor;
    if (read.title && !s.title) patch.title = read.title;
    if (Object.keys(patch).length > 0) this.deps.stores.sessions.patch(s.id, patch);
    this.transcriptStats.set(s.id, { path: "opencode.db", size: st.size, mtimeMs: st.mtimeMs });
    return { imported: read.events.length, peerMsgIds: [], responded: false };
  }

  /**
   * Adopt sessions the person started in an agent's own CLI (codex / opencode), by reading the
   * agent's storage. Claude needs none of this — its SessionStart hook announces sessions itself.
   * Only profiles the user switched on (`tiny live on --profile <name>`) are scanned, and only
   * sessions that carry something a person actually said are worth the phone's list.
   */
  scanExternalSessions(): number {
    let adopted = 0;
    let profiles;
    try {
      profiles = listProfiles(this.deps.profilesDir);
    } catch {
      return 0;
    }
    for (const p of profiles) {
      if (p.agent !== "codex" && p.agent !== "opencode") continue;
      if (this.deps.liveScanEnabled?.(p.name) !== true) continue;
      let sessions;
      try {
        sessions = p.agent === "codex" ? listCodexSessions(p.dir) : listOpencodeSessions(p.dir);
      } catch {
        continue;
      }
      for (const es of sessions) {
        if (!es.title) continue; // nothing said yet (includes tiny's own choice-fetch probes)
        if (this.deps.stores.sessions.byAgentSessionId(es.agentSessionId)) continue;
        if (!fs.existsSync(es.cwd)) continue; // a session whose cwd is gone cannot run turns anyway
        try {
          this.adoptSession({ profile: p.name, cwd: es.cwd, agentSessionId: es.agentSessionId });
          adopted++;
        } catch (err) {
          console.error(`[tinyd] could not adopt ${p.agent} session ${es.agentSessionId}:`, err);
        }
      }
    }
    return adopted;
  }

  /**
   * The CLI closed this session (SessionEnd hook, or `tiny attach` exiting). A handoff session
   * that never got a single event is dropped; any other is marked closed, which the list shows
   * until the phone sends or the CLI resumes it.
   *
   * Import the transcript before judging emptiness. The SessionStart hook adopts a session before
   * the user has typed anything, so the backfill at adoption time imports nothing; if nothing
   * syncs in between, a session that ran a whole conversation still looks empty here and would be
   * deleted. syncTranscript declines to import while a turn is running, and deleting on the
   * strength of a look we did not take would be the same bug in a new place — so a running
   * session is never dropped, only closed (its live turn ends on its own watcher)
   */
  cliSessionEnded(agentSessionId: string): { discarded: boolean; closed: boolean } {
    const s = this.deps.stores.sessions.byAgentSessionId(agentSessionId);
    if (!s) return { discarded: false, closed: false };
    if (s.status !== "running") {
      this.syncTranscript(s.id);
      if (this.deps.stores.events.count(s.id) === 0 && this.deps.stores.sessions.delete(s.id)) {
        // The row is gone: leave nothing behind that a later session could inherit
        this.cliSeenPid.delete(s.id);
        this.cliClosedPid.delete(s.id);
        this.ownSdkTurn.delete(s.id);
        return { discarded: true, closed: false };
      }
    }
    // The hook runs before the process exits, so its registry entry may still be there for a
    // moment: remember which pid closed, and observeCli will not take that pid for a reopen
    const pid = this.deps.cliState?.(s)?.pid ?? this.cliSeenPid.get(s.id);
    if (pid === undefined) this.cliClosedPid.delete(s.id);
    else this.cliClosedPid.set(s.id, pid);
    this.cliSeenPid.delete(s.id);
    this.deps.stores.sessions.setCliClosedAt(s.id, new Date().toISOString());
    return { discarded: false, closed: true };
  }

  /** The session is in use again (phone / resume / attach): the "closed" mark no longer applies */
  private clearCliClosed(id: string): void {
    this.cliClosedPid.delete(id);
    this.deps.stores.sessions.setCliClosedAt(id, null);
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
   * The live CLI process holding this session that a turn could be joined into, or null if it
   * cannot be joined (no peer bridge, not Claude, no agent session id yet, CLI not live, or the
   * peer bridge could not resolve a target). Claude only in Step 2; other agents keep the Step 1 rule
   */
  private joinTarget(s: SessionRecord): PeerTarget | null {
    if (!this.deps.peer || s.agent !== "claude" || !s.agentSessionId) return null;
    if (this.deps.isCliLive?.(s) !== true) return null;
    return this.deps.peer.resolve(s);
  }

  /**
   * Answer, from the phone, a question the CLI is asking (AskUserQuestion). The socket carries
   * messages, not tool results, so the answer goes in with priority "now": the CLI abandons its own
   * question prompt (recording the call as rejected) and takes the answers as the next thing its
   * person said — measured against Claude Code 2.1.251. The rejected echo is dropped on import, so
   * what both ends show is the question with the chosen answers under it.
   */
  async answerCliQuestion(id: string, toolUseId: string, answers: Record<string, string>): Promise<void> {
    const s = this.getSession(id);
    const target = this.joinTarget(s);
    if (!target) throw new ConflictError("the CLI holding this session is not reachable");
    if (Object.keys(answers).length === 0) throw new ValidationError("no answers");
    const text = SessionManager.answerMessage(answers);
    const live = this.liveTurns.get(id);
    // The question came out of a turn tiny started: that turn's watcher is still running and will
    // pick up the reply, so the answer only has to reach the socket
    if (live) {
      const content = wrapForPeer(text, { name: "tiny", mode: this.deps.peer!.mode(s, target) });
      // Claimed BEFORE the send: the CLI writes its rejection the instant the frame lands, and any
      // concurrent import (the phone has the chat open, so the stream syncs every 1.5s) would
      // otherwise turn that into a "Dismissed in the CLI" card ahead of the answer (device report)
      this.claimRejectedEcho(id, toolUseId);
      try {
        await this.deps.peer!.send(s, target, {
          agentSessionId: s.agentSessionId!, msgId: crypto.randomUUID(), content, priority: "now",
        });
      } catch (err) {
        this.releaseRejectedEcho(id, toolUseId);
        throw err;
      }
      this.recordPhoneAnswer(id, toolUseId, answers);
      return;
    }
    // The CLI asked on its own. Answering starts a live turn, so the phone sees it run and gets the
    // reply, exactly as sending a message from the phone does
    if (this.running.has(id)) throw new ConflictError("a turn is already running");
    this.claimRejectedEcho(id, toolUseId);
    this.launchTurn(s, text, undefined, null, { priority: "now", question: { toolUseId, answers } });
  }

  /** What the CLI receives as the answer. Spelled out: it arrives as a message, not as a tool result */
  private static answerMessage(answers: Record<string, string>): string {
    const lines = Object.entries(answers).map(([q, a]) => `- ${q}\n  -> ${a}`);
    return [
      "Answers to the question you just asked, chosen by your user on their phone:",
      lines.join("\n"),
      "(Delivering this cancelled the question prompt in the terminal, so the tool call shows as " +
        "rejected there. These are the real answers — continue with them.)",
    ].join("\n\n");
  }

  /**
   * Questions this session is waiting on. Rebuilt from the event log the first time it is asked
   * for: after a tinyd restart the phone would otherwise be left with a question card nothing can
   * ever close
   */
  private openQuestionIds(id: string): Set<string> {
    const known = this.openQuestions.get(id);
    if (known) return known;
    const open = new Set<string>();
    const seen = new Set<string>();
    for (const ev of this.deps.stores.events.listSince(id, 0)) {
      if (ev.type !== "cli_question" && ev.type !== "cli_question_answered") continue;
      const toolUseId = typeof ev.payload.toolUseId === "string" ? ev.payload.toolUseId : "";
      if (ev.type === "cli_question") {
        open.add(toolUseId);
        seen.add(toolUseId);
      } else {
        open.delete(toolUseId);
      }
    }
    this.openQuestions.set(id, open);
    this.seenQuestions.set(id, seen);
    return open;
  }

  /**
   * A question the CLI is asking right now, reported by the PreToolUse hook `tiny live` installs.
   * Returns false when there is no such session or the question is already in its history (the
   * transcript import can get there first on a hookless CLI). Never throws: it runs inside a hook
   */
  recordCliQuestion(agentSessionId: string, toolUseId: string, input: Record<string, unknown>): boolean {
    const s = this.deps.stores.sessions.byAgentSessionId(agentSessionId);
    if (!s) return false;
    this.openQuestionIds(s.id); // seeds seenQuestions from history
    if (this.seenQuestions.get(s.id)?.has(toolUseId)) return false;
    this.emitEvent(s.id, "cli_question", { toolUseId, input });
    return true;
  }

  /** From here on, the CLI's rejection of this question is our own doing and must not be shown */
  private claimRejectedEcho(id: string, toolUseId: string): void {
    let ids = this.phoneAnswered.get(id);
    if (!ids) {
      ids = new Set();
      this.phoneAnswered.set(id, ids);
    }
    ids.add(toolUseId);
  }

  /** The answer never reached the CLI: a rejection over there is the person's, and belongs on screen */
  private releaseRejectedEcho(id: string, toolUseId: string): void {
    const ids = this.phoneAnswered.get(id);
    if (!ids) return;
    ids.delete(toolUseId);
    if (ids.size === 0) this.phoneAnswered.delete(id);
  }

  private recordPhoneAnswer(id: string, toolUseId: string, answers: Record<string, string>): void {
    this.claimRejectedEcho(id, toolUseId);
    this.emitEvent(id, "cli_question_answered", { toolUseId, answers });
  }

  /** A question the hook already announced. The transcript's copy of it must not show up twice */
  private isKnownQuestion(id: string, ev: { type: string; payload: Record<string, unknown> }): boolean {
    if (ev.type !== "cli_question") return false;
    const toolUseId = typeof ev.payload.toolUseId === "string" ? ev.payload.toolUseId : "";
    return this.seenQuestions.get(id)?.has(toolUseId) === true;
  }

  /**
   * The transcript's record of a question this phone already answered: the CLI had to cancel its
   * prompt to take the answer, so it writes the call down as rejected. Dropped once — a later real
   * rejection of a re-asked question is a different tool_use id
   */
  private isRejectedEcho(id: string, ev: { type: string; payload: Record<string, unknown> }): boolean {
    if (ev.type !== "cli_question_answered" || ev.payload.rejected !== true) return false;
    const ids = this.phoneAnswered.get(id);
    const toolUseId = typeof ev.payload.toolUseId === "string" ? ev.payload.toolUseId : "";
    if (!ids?.has(toolUseId)) return false;
    ids.delete(toolUseId);
    if (ids.size === 0) this.phoneAnswered.delete(id);
    return true;
  }

  /**
   * Registry-side fallback for "the CLI closed this session": a process that was seen holding it
   * and is now gone. The SessionEnd hook is the primary signal (immediate, and it names the
   * session); this catches a terminal that was killed, and a config dir without `tiny live on`.
   * Called per row on every list / get, so it is cheap and does not throw in normal operation; a
   * row deleted between the caller's read and this call surfaces as `NotFoundError`, the same as
   * any other read. Returns the record as it stands afterwards
   */
  observeCli(s: SessionRecord): SessionRecord {
    if (s.agent !== "claude" || !s.agentSessionId) return s;
    const live = this.deps.isCliLive?.(s);
    if (live !== true && live !== false) return s; // cannot tell: no evidence either way
    if (live) {
      const entry = this.deps.cliState?.(s);
      if (!entry || this.isOwnProcess(s.id, entry)) return s;
      this.cliSeenPid.set(s.id, entry.pid);
      // The hook fires before the process exits, so the pid that closed the session can still be
      // there for a moment; only a different process means the person opened it again
      if (s.cliClosedAt === null || this.cliClosedPid.get(s.id) === entry.pid) return s;
      this.clearCliClosed(s.id);
      return this.getSession(s.id);
    }
    const seen = this.cliSeenPid.get(s.id);
    if (seen === undefined) return s; // never seen it open (or tinyd restarted since): the hook's job
    this.cliSeenPid.delete(s.id);
    this.cliClosedPid.set(s.id, seen);
    if (s.cliClosedAt !== null) return s;
    this.deps.stores.sessions.setCliClosedAt(s.id, new Date().toISOString());
    return this.getSession(s.id);
  }

  /**
   * tiny's own SDK turn on this session while a child of it may still be registered: running, or
   * ended within the grace window. The record itself, so callers can extend it
   */
  private ownTurnInWindow(id: string): { startedAt: number; endedAt: number | null } | null {
    const own = this.ownSdkTurn.get(id);
    if (!own) return null;
    if (own.endedAt === null) return own;
    const grace = this.deps.ownProcessGraceMs ?? OWN_PROCESS_GRACE_MS;
    return Date.now() - own.endedAt < grace ? own : null;
  }

  /** Whether a registry entry is the child of tiny's own SDK turn on this session (running, or just ended) */
  private isOwnProcess(id: string, entry: LiveSessionEntry): boolean {
    const own = this.ownTurnInWindow(id);
    if (!own) return false;
    const started = entry.startedAt === null ? NaN : Date.parse(entry.startedAt);
    // An entry that does not say when it started, inside our window: do not guess
    return Number.isNaN(started) || started >= own.startedAt;
  }

  /** Whether a turn sent now would run inside the user's CLI (live join) rather than be refused */
  canJoin(s: SessionRecord): boolean {
    return this.joinTarget(s) !== null;
  }

  /**
   * Send a message. While a turn is running the message is queued instead of refused (`queued:
   * true`), the way typing during a turn queues in the CLI, and runs as its own turn as soon as
   * the current one ends.
   */
  startTurn(id: string, prompt: string, images?: TurnImage[]): { queued: boolean } {
    const s = this.getSession(id);
    if (s.status === "detached") throw new ConflictError("session is attached from CLI");
    // Sent from the phone: whatever the CLI did with this session, it is tiny's again
    if (s.cliClosedAt !== null) this.clearCliClosed(id);
    if (s.status === "running") {
      if (this.running.has(id)) {
        const q = this.queued.get(id) ?? [];
        if (q.length >= SessionManager.MAX_QUEUED) {
          throw new ConflictError(`too many queued messages (${SessionManager.MAX_QUEUED}); wait for the turn to finish`);
        }
        // Persist now: a queued message the person cannot see is a message they will send twice
        const saved = this.persistUserMessage(id, prompt, images);
        q.push({ prompt, ...(images ? { images } : {}), paths: saved.paths });
        this.queued.set(id, q);
        return { queued: true };
      }
      // The status outlived whatever set it — tinyd was killed mid-turn, or a turn crashed the
      // process. Nothing is running, so refusing every later turn (and, through the same flag,
      // never importing the transcript again) would keep the session broken until a restart
      console.error(`[tinyd] session ${id} was marked running with no turn in flight; clearing it`);
      this.deps.stores.sessions.patch(id, { status: "idle" });
    }
    this.launchTurn(this.getSession(id), prompt, images, null);
    return { queued: false };
  }

  /**
   * Start a turn for real. `saved` is set when the message was already persisted (it came off the
   * queue), so it is not written into the conversation twice.
   */
  private launchTurn(
    s: SessionRecord,
    prompt: string,
    images: TurnImage[] | undefined,
    saved: { paths: string[] } | null,
    live?: LiveSend,
  ): void {
    const id = s.id;
    // A turn the agent's own CLI is running (seen through its storage): a second writer on the
    // same session is the one thing every agent forbids. codex / opencode have no live join (yet)
    const ext = this.transcriptTurns.get(id);
    if ((s.agent === "codex" || s.agent === "opencode") && ext?.open === true && this.deps.externalBusy?.(s) !== false) {
      throw new ConflictError("a turn is running in the agent's own CLI");
    }
    // The CLI holds the session. Running the turn in a second process would race it on the
    // transcript, so either hand the message to that very process (live join) or refuse
    const isLive = this.deps.isCliLive?.(s) === true;
    const target = isLive ? this.joinTarget(s) : null;
    if (isLive && !target) throw new ConflictError("session is open in the CLI");
    this.deps.stores.sessions.patch(id, { status: "running", title: s.title ?? prompt.slice(0, 60) });
    const abort = new AbortController();
    this.turnProgress.set(id, { since: new Date().toISOString(), outputTokens: null });
    const finish = (): void => {
      this.running.delete(id);
      this.turnProgress.delete(id);
      const own = this.ownSdkTurn.get(id);
      if (own && own.endedAt === null) own.endedAt = Date.now();
      this.startNextQueued(id);
    };
    // In the map BEFORE anything can run: an SDK turn trips the agent's SessionStart hook while
    // still on this call stack, and that re-enters the manager (adoptSession -> syncTranscript),
    // which must see the turn in flight or it imports records tiny is in the middle of emitting
    const entry: RunningTurn = { abort, done: Promise.resolve() };
    this.running.set(id, entry);
    if (target) {
      // An answer to a question is not a message the person typed: it belongs in the conversation
      // as the question's answer card, which runLiveTurn writes once the CLI has taken it
      const paths = live?.question ? [] : saved ? saved.paths : this.persistUserMessage(id, prompt, images).paths;
      entry.done = this.runLiveTurn(s, prompt, paths, target, abort.signal, live).finally(finish);
      return;
    }
    if (!saved) this.persistUserMessage(id, prompt, images);
    // Back-to-back turns (a queued message starts the next one the instant this one settles) extend
    // the window instead of restarting it: the previous turn's child can still be the registry's
    // entry for this session, and a window starting now would read that child as the person's
    // terminal and close the session when it goes. A missed close is the safe way to be wrong here
    const own = this.ownTurnInWindow(id);
    if (own) own.endedAt = null;
    else this.ownSdkTurn.set(id, { startedAt: Date.now(), endedAt: null });
    entry.done = this.runTurn(s, prompt, images, abort.signal).finally(finish);
  }

  /**
   * Run the next queued message, if any. Called as each turn ends. A message that cannot be
   * launched (the CLI took the session over in the meantime) is reported as a failed turn, and the
   * rest of the queue goes with it: whatever blocked this one blocks them all
   */
  private startNextQueued(id: string): void {
    const q = this.queued.get(id);
    const next = q?.shift();
    if (!next) {
      this.queued.delete(id);
      return;
    }
    if (q!.length === 0) this.queued.delete(id);
    try {
      this.launchTurn(this.getSession(id), next.prompt, next.images, { paths: next.paths });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.queued.delete(id);
      try {
        this.emitEvent(id, "turn_failed", { error: reason });
      } catch {
        // the session row is gone (deleted under the queue); there is nowhere to record it
      }
    }
  }

  /**
   * The turn in progress on this session, from whichever side started it: a turn tiny runs (SDK or
   * live join), or one the person typed into the CLI, which tiny only sees through the registry
   * status and the transcript. null when idle. Nothing here is persisted — it is a live reading
   */
  activity(s: SessionRecord): SessionActivity | null {
    const own = this.turnProgress.get(s.id);
    if (own) {
      // A live turn's output is written by the CLI, so the transcript is the only place it shows up
      const fromTranscript = this.liveTurns.has(s.id) ? this.transcriptTurns.get(s.id)?.outputTokens ?? null : null;
      return { since: own.since, outputTokens: own.outputTokens ?? fromTranscript };
    }
    if (s.agent === "codex" || s.agent === "opencode") {
      // A turn the person runs in the agent's own CLI: the storage says open, and process-level
      // evidence (when available) has not said "nobody is there"
      const ext = this.transcriptTurns.get(s.id);
      if (ext?.open === true && this.deps.externalBusy?.(s) !== false) {
        return { since: ext.startedAt, outputTokens: ext.outputTokens > 0 ? ext.outputTokens : null };
      }
      return null;
    }
    const st = this.deps.cliState?.(s);
    if (!st || !CLI_BUSY.has(st.status)) return null;
    // Waiting on a background task: the turn is over, so its tokens are not "so far"; the clock
    // runs from when the wait began
    if (st.status === "shell") return { since: st.statusUpdatedAt, outputTokens: null, reason: "background" };
    // The transcript's newest turn is only trustworthy if it was read after the CLI went busy;
    // otherwise it is the PREVIOUS turn (nobody syncs the transcript while the phone sits on the
    // session list), and its token count would be shown against the wrong turn
    const seen = this.transcriptTurns.get(s.id);
    const busySince = st.statusUpdatedAt ? Date.parse(st.statusUpdatedAt) : NaN;
    const fresh = seen && (Number.isNaN(busySince) || seen.readAt >= busySince) ? seen : null;
    return {
      since: fresh?.startedAt ?? st.statusUpdatedAt,
      outputTokens: fresh ? fresh.outputTokens : null,
    };
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
        progress: (p) => {
          const t = this.turnProgress.get(s.id);
          if (t) t.outputTokens = p.outputTokens;
        },
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
  private async runLiveTurn(
    s: SessionRecord,
    prompt: string,
    imagePaths: string[],
    target: PeerTarget,
    signal: AbortSignal,
    send?: LiveSend,
  ): Promise<void> {
    const timing = this.deps.liveTiming ?? DEFAULT_LIVE_TIMING;
    const live: LiveTurn = {
      msgId: crypto.randomUUID(), target, startedAt: Date.now(), deliveredAt: null,
      sawResponse: false, idleUndeliveredSince: null, idleDeliveredSince: null, unknownSince: null,
      lastStatus: null, stopMsgId: null, stopDeliveredAt: null,
      stopFailure: null, lastAssistantText: null,
    };
    this.liveTurns.set(s.id, live);
    try {
      // The CLI's inbox takes text only; images go on disk where the CLI can Read them
      const body = prompt + imagePaths.map((p) => `\n[attached image: ${p}]`).join("");
      const content = wrapForPeer(body, { name: "tiny", mode: this.deps.peer!.mode(s, target) });
      try {
        await this.deps.peer!.send(s, target, {
          agentSessionId: s.agentSessionId!, msgId: live.msgId, content, priority: send?.priority ?? "next",
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        // Nothing reached the CLI, so nothing over there was cancelled: let a real dismissal through again
        if (send?.question) this.releaseRejectedEcho(s.id, send.question.toolUseId);
        this.emitEvent(s.id, "turn_failed", { error: `could not reach the CLI: ${reason}` });
        return;
      }
      if (send?.question) this.recordPhoneAnswer(s.id, send.question.toolUseId, send.question.answers);
      this.emitEvent(s.id, "turn_started", { agentSessionId: s.agentSessionId });
      for (;;) {
        await new Promise((r) => setTimeout(r, timing.pollMs));
        // No live path calls abort() today (interrupt() sends a Stop message instead), but a
        // future/shutdown path must be able to stop the poller through the same AbortController
        // startTurn already stores in `this.running`
        if (signal.aborted) {
          this.emitEvent(s.id, "turn_failed", { error: "interrupted" });
          return;
        }
        const outcome = this.pollLiveTurn(s, live, timing);
        if (outcome) {
          this.emitEvent(s.id, outcome.type, outcome.payload);
          return;
        }
      }
    } catch (err) {
      // A throw here (e.g. getSession -> NotFoundError after the session was deleted, or a store
      // error) must still end the turn visibly, mirroring runTurn's own catch-all
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[tinyd] live turn crashed: ${reason}`);
      try {
        this.emitEvent(s.id, "turn_failed", { error: reason });
      } catch (emitErr) {
        // The session row itself may be gone; there is nowhere left to record the failure
        console.error("[tinyd] could not record turn_failed for a crashed live turn:", emitErr);
      }
    } finally {
      this.liveTurns.delete(s.id);
      try {
        this.deps.stores.sessions.patch(s.id, { status: "idle" });
      } catch {
        // The session row may already be gone (deleted mid-turn) — nothing left to patch
      }
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
    // Delivery/response evidence is recorded on `live` by importTranscript itself (so a concurrent
    // syncTranscript caller cannot steal it) — this call only advances the cursor and, if this tick
    // is the one that catches it, updates that evidence. Read `live.*` below, not the return value
    this.importTranscript(s.id);

    const st = this.deps.peer!.status(s, live.target);
    if (st === null) return { type: "turn_failed", payload: { error: "the CLI closed" } };
    // Stop was tapped but never reached the CLI. The turn is still running over there, yet the
    // person is owed an answer now rather than whenever the CLI finishes
    if (live.stopFailure !== null) {
      return { type: "turn_failed", payload: { error: `could not stop the CLI: ${live.stopFailure}` } };
    }
    // "unknown" means the registry entry was caught mid-write, not that the CLI changed state. It
    // carries no information, so the tick must leave every clock and every latch exactly as it was:
    // recording it in lastStatus would make the next readable tick look like a fresh wait, and
    // treating it as "not idle" would restart the delivery clock on every second tick. Only an entry
    // that stays unreadable is a verdict: the turn cannot be judged from a broken registry
    if (st.status === "unknown") {
      live.unknownSince ??= now;
      if (now - live.unknownSince > timing.deliveryTimeoutMs) {
        return { type: "turn_failed", payload: { error: "the CLI's state could not be read" } };
      }
      return null;
    }
    live.unknownSince = null;
    if (st.status === "waiting" && live.lastStatus !== "waiting") {
      this.emitEvent(s.id, "cli_attention", { reason: st.waitingFor ?? "input" });
    }
    live.lastStatus = st.status;

    // Stop was tapped: the turn ends as "interrupted" only once the CLI has taken the STOP message
    // itself (not merely the original message) and gone idle. "interrupted" is what the SDK path
    // reports too, so the app shows Stopped
    if (live.stopMsgId !== null && live.stopDeliveredAt !== null && st.status === "idle") {
      return { type: "turn_failed", payload: { error: "interrupted" } };
    }
    if (live.deliveredAt !== null && st.status === "idle") {
      // The CLI marks itself busy BEFORE it writes our message down (measured on 2.1.252: 56ms
      // earlier) and idle once the reply is written. So idle after delivery is the turn ending. Three
      // ways to be sure the reading is not older than the delivery: the reply already arrived; the
      // registry's own clock puts the idle after our delivery; or the CLI has now been idle for a
      // settle period (covers a turn so short it ended before the poll that noticed the delivery,
      // and produced nothing we could see)
      live.idleDeliveredSince ??= now;
      const idleAfterDelivery = st.since !== undefined && st.since >= live.deliveredAt;
      if (live.sawResponse || idleAfterDelivery || now - live.idleDeliveredSince >= timing.idleSettleMs) {
        return { type: "turn_completed", payload: { costUsd: null, resultText: live.lastAssistantText ?? null } };
      }
      return null;
    }
    live.idleDeliveredSince = null;
    // Idle or waiting time counts against delivery: while the CLI is busy with its own turn our
    // message sits in its queue, and that can legitimately take minutes — or hours; a busy CLI is
    // never given up on. "waiting" must count too — a fresh bypass session with no transcript yet
    // holds an unattested message and reports status: "waiting" indistinguishably from a real
    // permission prompt, so it would otherwise hang instead of surfacing as a failure
    if (live.deliveredAt === null && (st.status === "idle" || st.status === "waiting")) {
      live.idleUndeliveredSince ??= now;
      if (now - live.idleUndeliveredSince > timing.deliveryTimeoutMs) {
        return {
          type: "turn_failed",
          payload: { error: "the CLI did not take the message (most likely held for review in the terminal; a repeat of the previous message within 30s is also dropped, and bursts are rate-limited)" },
        };
      }
    } else {
      live.idleUndeliveredSince = null;
    }
    // busy / shell (the person's own `!` command) / waiting for the person at the terminal: the CLI
    // is doing something, and no clock runs against that. Stop from the phone is the way out
    return null;
  }

  /** Save an agent-sent file to the outbox and record file_sent (the `tiny mcp-server` -> POST /files path) */
  saveUserFile(sessionId: string, filePath: string, caption?: string): FileRecord {
    this.getSession(sessionId); // NotFoundError if missing
    const rec = this.deps.outbox.save(sessionId, filePath, caption);
    this.emitEvent(sessionId, "file_sent", { fileId: rec.id, mime: rec.mime, caption: rec.caption, name: rec.originalPath });
    return rec;
  }

  /**
   * Close the turns the previous tinyd process was driving. Nothing about them survives a restart,
   * so each session still marked running (or left "interrupted" by an older tinyd, which changed the
   * status without telling anyone) gets the closing event the phone has been waiting for since its
   * turn_started — with the truth about what happened. Meant to run before anything listens for
   * events, so a restart pushes nothing; the closing event reaches the phone as history
   */
  recoverAfterRestart(): number {
    let n = 0;
    for (const archived of [false, true]) {
      for (const status of ["running", "interrupted"] as const) {
        for (const s of this.deps.stores.sessions.list(status, archived)) {
          if (this.hasOpenTurn(s.id)) {
            if (this.deps.isCliLive?.(s) === true) {
              // The agent's CLI holds the session, so this was a live join: the message was handed
              // to that very process, which kept working through the restart. Only tinyd's watcher is
              // gone. From here the CLI's work is imported like any turn of its own, and the list shows
              // it running from the registry for as long as it is
              this.emitEvent(s.id, "turn_completed", { costUsd: null, resultText: null });
            } else {
              // tinyd's own child died with it: the turn was cut short, exactly like a Stop
              this.emitEvent(s.id, "turn_failed", { error: "interrupted" });
            }
          }
          this.deps.stores.sessions.patch(s.id, { status: "idle" });
          n++;
        }
      }
    }
    return n;
  }

  /** Whether the event log ends inside a turn (a turn_started with nothing closing it yet) */
  private hasOpenTurn(id: string): boolean {
    let open = false;
    for (const ev of this.deps.stores.events.listSince(id, 0)) {
      if (ev.type === "turn_started") open = true;
      else if (ev.type === "turn_completed" || ev.type === "turn_failed" || ev.type === "auth_error") open = false;
    }
    return open;
  }

  /** Resolves when nothing is running for this session any more — including anything queued behind it */
  async waitForIdle(id: string): Promise<void> {
    for (;;) {
      const turn = this.running.get(id);
      if (!turn) return;
      await turn.done;
    }
  }

  async interrupt(id: string): Promise<void> {
    const s = this.getSession(id);
    // Stop means stop: what was queued behind this turn goes too, as it does in the CLI
    this.queued.delete(id);
    const live = this.liveTurns.get(id);
    if (!live) {
      const own = this.running.get(id);
      if (own) {
        own.abort.abort();
        return;
      }
      await this.stopCliTurn(s);
      return;
    }
    // The CLI owns this turn and its socket has no cancel — but a "now" message makes it abandon
    // what it is doing and take that message instead (measured). Send the stop note that way;
    // the watcher closes the turn as "interrupted" once the CLI has taken it
    if (live.stopMsgId !== null) return; // already stopping
    live.stopMsgId = crypto.randomUUID();
    const content = wrapForPeer(PEER_STOP, { name: "tiny", mode: this.deps.peer!.mode(s, live.target) });
    this.deps.peer!
      .send(s, live.target, { agentSessionId: s.agentSessionId!, msgId: live.stopMsgId, content, priority: "now" })
      .catch((err) => {
        const reason = err instanceof Error ? err.message : String(err);
        live.stopMsgId = null; // let a later tap try again
        // The watcher turns this into the turn's terminal event. Emitting from here instead would
        // give the turn a second terminal path, racing the one in pollLiveTurn
        live.stopFailure = reason;
        console.error(`[tinyd] could not send stop to the CLI: ${reason}`);
      });
  }

  /**
   * Stop a turn tiny did not start: the person typed it into the terminal (or another session sent
   * it there), and the phone shows it running from the registry status. Who started a turn makes no
   * difference to the person tapping Stop, so it is stopped the way a live turn is — with the same
   * "now" message the CLI takes instead of continuing. Awaited so a socket failure reaches the tap
   */
  private async stopCliTurn(s: SessionRecord): Promise<void> {
    const st = this.deps.cliState?.(s);
    if (!st || !CLI_BUSY.has(st.status)) return; // nothing is running anywhere
    const target = this.joinTarget(s);
    if (!target) throw new ConflictError("the CLI holds this session but tiny cannot reach it");
    const content = wrapForPeer(PEER_STOP, { name: "tiny", mode: this.deps.peer!.mode(s, target) });
    await this.deps.peer!.send(s, target, {
      agentSessionId: s.agentSessionId!, msgId: crypto.randomUUID(), content, priority: "now",
    });
  }

  setDetached(id: string, detached: boolean): SessionRecord {
    const s = this.getSession(id);
    if (detached && s.status === "running") throw new ConflictError("turn running");
    if (detached && s.cliClosedAt !== null) this.clearCliClosed(id);
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
