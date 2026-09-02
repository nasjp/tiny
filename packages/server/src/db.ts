import fs from "node:fs";
import Database from "better-sqlite3";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent_session_id TEXT,
  agent TEXT NOT NULL,
  profile TEXT NOT NULL,
  cwd TEXT NOT NULL,
  permission_mode TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  title TEXT,
  status TEXT NOT NULL,
  archived_at TEXT,
  source_cursor TEXT,
  cli_closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, id);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  bearer_token TEXT NOT NULL UNIQUE,
  apns_token TEXT,
  apns_env TEXT NOT NULL DEFAULT 'production',
  e2e_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  original_path TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  mime TEXT NOT NULL,
  caption TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pairing_codes (
  code TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);
`;

export function openDb(file: string): Database.Database {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  migrate(db);
  // The DB holds every device's bearer_token (auth) and e2e_key (push decryption key).
  // With the default 644, other users on the same Mac or backups could read it. Restrict to owner only
  // (WAL/SHM contain the same data, so restrict them too; skip files that don't exist yet).
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.chmodSync(`${file}${suffix}`, 0o600);
    } catch {
      // Ignore files not yet created (WAL/SHM) or environments where chmod is not allowed
    }
  }
  return db;
}

/** Add missing columns to an existing DB, since CREATE TABLE IF NOT EXISTS never adds columns. */
function migrate(db: Database.Database): void {
  addColumnIfMissing(db, "devices", "apns_env", "TEXT NOT NULL DEFAULT 'production'");
  addColumnIfMissing(db, "sessions", "model", "TEXT");
  addColumnIfMissing(db, "sessions", "effort", "TEXT");
  addColumnIfMissing(db, "sessions", "archived_at", "TEXT");
  addColumnIfMissing(db, "sessions", "source_cursor", "TEXT");
  addColumnIfMissing(db, "sessions", "cli_closed_at", "TEXT");
}

function addColumnIfMissing(db: Database.Database, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
