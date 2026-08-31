import crypto from "node:crypto";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import type { AgentAdapter, TurnImage } from "./adapter.js";
import type { McpLaunch } from "./mcp-launch.js";
import type { FileOutbox } from "./outbox.js";
import { profileDir, profileDriver } from "./profiles.js";
import { findTranscript, readTranscript, readTranscriptCursor } from "./claude-transcript.js";
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
}

interface RunningTurn {
  abort: AbortController;
  done: Promise<void>;
}

export class SessionManager extends EventEmitter {
  private running = new Map<string, RunningTurn>();

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
   * How many human turns a first backfill imports. Counting records instead would fill the
   * import with tool traffic and almost none of the conversation the person came back for
   */
  private static readonly BACKFILL_TURNS = 10;

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
   * Move the cursor to the transcript's current tail without emitting anything.
   * Never throws — an unreadable transcript just leaves the cursor where it is.
   */
  private advanceCursor(s: SessionRecord): void {
    try {
      const file = this.transcriptFile(s);
      if (!file) return;
      const cursor = readTranscriptCursor(file);
      if (cursor && cursor !== s.sourceCursor) this.deps.stores.sessions.patch(s.id, { sourceCursor: cursor });
    } catch {
      // same non-throwing contract as syncTranscript: a missing transcript is normal
    }
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
    const s = this.getSession(id);
    const file = this.transcriptFile(s);
    if (!file) return 0;
    const read = readTranscript(file, {
      sinceUuid: s.sourceCursor,
      ...(s.sourceCursor ? {} : { turns: SessionManager.BACKFILL_TURNS }),
    });
    for (const ev of read.events) this.emitEvent(id, ev.type, ev.payload);
    const patch: SessionPatch = {};
    if (read.cursor && read.cursor !== s.sourceCursor) patch.sourceCursor = read.cursor;
    if (read.title && !s.title) patch.title = read.title;
    if (Object.keys(patch).length > 0) this.deps.stores.sessions.patch(id, patch);
    return read.events.length;
  }

  /** SessionEnd path: drop a handoff session that never got a single event */
  discardIfEmpty(agentSessionId: string): boolean {
    const s = this.deps.stores.sessions.byAgentSessionId(agentSessionId);
    if (!s) return false;
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

  startTurn(id: string, prompt: string, images?: TurnImage[]): void {
    const s = this.getSession(id);
    if (s.status === "running") throw new ConflictError("turn already running");
    if (s.status === "detached") throw new ConflictError("session is attached from CLI");
    // Step 1 has no live-join yet: a turn sent while the CLI holds the session would run in a
    // separate process and the CLI can overwrite the transcript leaf on exit, stranding it
    if (this.deps.isCliLive?.(s) === true) throw new ConflictError("session is open in the CLI");
    const abort = new AbortController();
    this.deps.stores.sessions.patch(id, { status: "running", title: s.title ?? prompt.slice(0, 60) });
    // Persist the user's message as an event too. Without this, the client's history view
    // shows no user-side bubbles at all (the SDK stream does not include the prompt).
    // Images are saved to the outbox and given a fileId (so history can show thumbnails).
    // A save failure must not block the send itself (only the image count remains in that case)
    let imageFileIds: string[] = [];
    try {
      imageFileIds = (images ?? []).map(
        (img) => this.deps.outbox.saveData(id, Buffer.from(img.data, "base64"), img.mediaType).id,
      );
    } catch (err) {
      console.error("[tinyd] failed to persist turn images:", err);
      imageFileIds = [];
    }
    this.emitEvent(id, "user_message", {
      text: prompt,
      ...(images && images.length > 0 ? { imageCount: images.length } : {}),
      ...(imageFileIds.length > 0 ? { imageFileIds } : {}),
    });
    const done = this.runTurn(s, prompt, images, abort.signal).finally(() => this.running.delete(id));
    this.running.set(id, { abort, done });
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
      // This turn appended to the same transcript the user's CLI writes, and every one of those
      // records was already emitted natively above. Skip past them so a later sync cannot replay them
      const after = this.deps.stores.sessions.get(s.id);
      if (after?.sourceCursor) this.advanceCursor(after);
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
      if (mcpToken) this.deps.sessionTokens!.revokeSessionTokens(s.id);
    }
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
    this.getSession(id);
    this.running.get(id)?.abort.abort();
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
