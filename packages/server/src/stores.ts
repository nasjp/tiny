import type Database from "better-sqlite3";
import type { ApnsEnv, DeviceRecord, EventRecord, FileRecord, SessionRecord, SessionStatus } from "./types.js";

interface SessionRow {
  id: string; agent_session_id: string | null; agent: string; profile: string;
  cwd: string; permission_mode: string; model: string | null; effort: string | null; title: string | null; status: string; archived_at: string | null; source_cursor: string | null;
  cli_closed_at: string | null;
  created_at: string; updated_at: string;
}

function rowToSession(r: SessionRow): SessionRecord {
  return {
    id: r.id,
    agentSessionId: r.agent_session_id,
    agent: r.agent as SessionRecord["agent"],
    profile: r.profile,
    cwd: r.cwd,
    permissionMode: r.permission_mode as SessionRecord["permissionMode"],
    model: r.model,
    effort: r.effort,
    title: r.title,
    status: r.status as SessionStatus,
    archivedAt: r.archived_at,
    sourceCursor: r.source_cursor,
    cliClosedAt: r.cli_closed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface SessionPatch {
  status?: SessionStatus;
  agentSessionId?: string;
  title?: string;
  model?: string | null;
  effort?: string | null;
  permissionMode?: SessionRecord["permissionMode"];
  archivedAt?: string | null;
  sourceCursor?: string | null;
}

export function createStores(db: Database.Database) {
  const sessions = {
    create(rec: SessionRecord): void {
      db.prepare(
        `INSERT INTO sessions (id, agent_session_id, agent, profile, cwd, permission_mode, model, effort, title, status, archived_at, source_cursor, cli_closed_at, created_at, updated_at)
         VALUES (@id, @agentSessionId, @agent, @profile, @cwd, @permissionMode, @model, @effort, @title, @status, @archivedAt, @sourceCursor, @cliClosedAt, @createdAt, @updatedAt)`,
      ).run(rec);
    },
    get(id: string): SessionRecord | null {
      const row = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
      return row ? rowToSession(row) : null;
    },
    list(status?: SessionStatus, archived = false): SessionRecord[] {
      const arch = archived ? "archived_at IS NOT NULL" : "archived_at IS NULL";
      const rows = (status
        ? db.prepare(`SELECT * FROM sessions WHERE status = ? AND ${arch} ORDER BY updated_at DESC`).all(status)
        : db.prepare(`SELECT * FROM sessions WHERE ${arch} ORDER BY updated_at DESC`).all()) as SessionRow[];
      return rows.map(rowToSession);
    },
    /** Working-directory history. Deduplicated including archived sessions, newest last-use (updated_at) first */
    recentCwds(): string[] {
      const rows = db.prepare(
        `SELECT cwd FROM sessions GROUP BY cwd ORDER BY MAX(updated_at) DESC`,
      ).all() as { cwd: string }[];
      return rows.map((r) => r.cwd);
    },
    patch(id: string, patch: SessionPatch): void {
      const cur = sessions.get(id);
      if (!cur) throw new Error(`session not found: ${id}`);
      db.prepare(
        `UPDATE sessions SET status = ?, agent_session_id = ?, title = ?, model = ?, effort = ?, permission_mode = ?, archived_at = ?, source_cursor = ?, updated_at = ? WHERE id = ?`,
      ).run(
        patch.status ?? cur.status,
        patch.agentSessionId ?? cur.agentSessionId,
        patch.title ?? cur.title,
        // model allows clearing to null, so distinguish only from undefined (unspecified)
        patch.model !== undefined ? patch.model : cur.model,
        patch.effort !== undefined ? patch.effort : cur.effort,
        patch.permissionMode ?? cur.permissionMode,
        patch.archivedAt !== undefined ? patch.archivedAt : cur.archivedAt,
        patch.sourceCursor !== undefined ? patch.sourceCursor : cur.sourceCursor,
        new Date().toISOString(),
        id,
      );
    },
    /**
     * The "closed in the CLI" mark. Leaves updated_at alone: closing is not conversation activity,
     * so the list keeps its order and the unread dot stays off (same reasoning as renameProfile)
     */
    setCliClosedAt(id: string, at: string | null): void {
      const r = db.prepare(`UPDATE sessions SET cli_closed_at = ? WHERE id = ?`).run(at, id);
      if (r.changes === 0) throw new Error(`session not found: ${id}`);
    },
    // For profile rename. Leaves updated_at alone (a rename is not session activity,
    // so the list order should not move)
    renameProfile(from: string, to: string): number {
      return db.prepare(`UPDATE sessions SET profile = ? WHERE profile = ?`).run(to, from).changes;
    },
    byAgentSessionId(agentSessionId: string): SessionRecord | null {
      const row = db.prepare(`SELECT * FROM sessions WHERE agent_session_id = ? ORDER BY created_at ASC LIMIT 1`)
        .get(agentSessionId) as SessionRow | undefined;
      return row ? rowToSession(row) : null;
    },
    delete(id: string): boolean {
      db.prepare(`DELETE FROM events WHERE session_id = ?`).run(id);
      return db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id).changes > 0;
    },
  };

  const events = {
    append(sessionId: string, type: string, payload: Record<string, unknown>): EventRecord {
      const createdAt = new Date().toISOString();
      const info = db.prepare(
        `INSERT INTO events (session_id, type, payload, created_at) VALUES (?, ?, ?, ?)`,
      ).run(sessionId, type, JSON.stringify(payload), createdAt);
      return { id: Number(info.lastInsertRowid), sessionId, type, payload, createdAt };
    },
    listSince(sessionId: string, sinceId: number): EventRecord[] {
      const rows = db.prepare(
        `SELECT * FROM events WHERE session_id = ? AND id > ? ORDER BY id ASC`,
      ).all(sessionId, sinceId) as Array<{ id: number; session_id: string; type: string; payload: string; created_at: string }>;
      return rows.map((r) => ({
        id: r.id, sessionId: r.session_id, type: r.type,
        payload: JSON.parse(r.payload) as Record<string, unknown>, createdAt: r.created_at,
      }));
    },
    count(sessionId: string): number {
      const r = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE session_id = ?`).get(sessionId) as { n: number };
      return r.n;
    },
  };

  interface DeviceRow {
    id: string; name: string; bearer_token: string; apns_token: string | null;
    apns_env: string; e2e_key: string; created_at: string;
  }

  const rowToDevice = (r: DeviceRow): DeviceRecord => ({
    id: r.id,
    name: r.name,
    bearerToken: r.bearer_token,
    apnsToken: r.apns_token,
    apnsEnv: r.apns_env === "sandbox" ? "sandbox" : "production",
    e2eKey: r.e2e_key,
    createdAt: r.created_at,
  });

  const devices = {
    insert(rec: DeviceRecord): void {
      db.prepare(
        `INSERT INTO devices (id, name, bearer_token, apns_token, apns_env, e2e_key, created_at)
         VALUES (@id, @name, @bearerToken, @apnsToken, @apnsEnv, @e2eKey, @createdAt)`,
      ).run(rec);
    },
    byToken(token: string): DeviceRecord | null {
      const r = db.prepare(`SELECT * FROM devices WHERE bearer_token = ?`).get(token) as DeviceRow | undefined;
      return r ? rowToDevice(r) : null;
    },
    byId(id: string): DeviceRecord | null {
      const r = db.prepare(`SELECT * FROM devices WHERE id = ?`).get(id) as DeviceRow | undefined;
      return r ? rowToDevice(r) : null;
    },
    list(): DeviceRecord[] {
      return (db.prepare(`SELECT * FROM devices ORDER BY created_at ASC`).all() as DeviceRow[]).map(rowToDevice);
    },
    setApnsToken(id: string, apnsToken: string, apnsEnv: ApnsEnv): void {
      db.prepare(`UPDATE devices SET apns_token = ?, apns_env = ? WHERE id = ?`).run(apnsToken, apnsEnv, id);
    },
    /** Called when APNs returns BadDeviceToken / Unregistered. The env is kept for the next registration. */
    clearApnsToken(id: string): void {
      db.prepare(`UPDATE devices SET apns_token = NULL WHERE id = ?`).run(id);
    },
    /** Device revocation (`tiny devices revoke`). The bearer becomes invalid at the same time. */
    delete(id: string): boolean {
      return db.prepare(`DELETE FROM devices WHERE id = ?`).run(id).changes > 0;
    },
  };

  const files = {
    insert(rec: FileRecord): void {
      db.prepare(
        `INSERT INTO files (id, session_id, original_path, stored_path, mime, caption, created_at)
         VALUES (@id, @sessionId, @originalPath, @storedPath, @mime, @caption, @createdAt)`,
      ).run(rec);
    },
    get(id: string): FileRecord | null {
      const r = db.prepare(`SELECT * FROM files WHERE id = ?`).get(id) as
        | { id: string; session_id: string; original_path: string; stored_path: string; mime: string; caption: string | null; created_at: string }
        | undefined;
      return r
        ? { id: r.id, sessionId: r.session_id, originalPath: r.original_path, storedPath: r.stored_path, mime: r.mime, caption: r.caption, createdAt: r.created_at }
        : null;
    },
  };

  const pairings = {
    put(code: string, expiresAt: string): void {
      db.prepare(`INSERT OR REPLACE INTO pairing_codes (code, expires_at) VALUES (?, ?)`).run(code, expiresAt);
    },
    take(code: string): boolean {
      const r = db.prepare(`SELECT expires_at FROM pairing_codes WHERE code = ?`).get(code) as
        | { expires_at: string }
        | undefined;
      if (!r) return false;
      db.prepare(`DELETE FROM pairing_codes WHERE code = ?`).run(code);
      return new Date(r.expires_at).getTime() > Date.now();
    },
  };

  return { sessions, events, devices, files, pairings };
}

export type Stores = ReturnType<typeof createStores>;
