import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";

describe("openDb", () => {
  it("makes the DB file owner-only read/write (0600)", () => {
    // Contains every device's bearer_token / e2e_key, so the default 644 is dangerous
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-db-"));
    const file = path.join(dir, "tiny.db");
    const db = openDb(file);
    db.prepare("INSERT INTO pairing_codes (code, expires_at) VALUES (?, ?)").run("X", "later");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // WAL contains the same data, so it is restricted too (if it exists)
    const wal = `${file}-wal`;
    if (fs.existsSync(wal)) expect(fs.statSync(wal).mode & 0o777).toBe(0o600);
    db.close();
  });

  it("opens an existing DB without the archived_at column via migration", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tiny-db-mig-")), "old.db");
    const legacy = new Database(file);
    legacy.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, agent_session_id TEXT, agent TEXT NOT NULL, profile TEXT NOT NULL,
      cwd TEXT NOT NULL, permission_mode TEXT NOT NULL, model TEXT, effort TEXT, title TEXT,
      status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    legacy.close();
    const db = openDb(file);
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "archived_at")).toBe(true);
    db.close();
  });

  it("adds source_cursor to an existing sessions table", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tiny-db-")), "old.db");
    const raw = new Database(file);
    raw.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, agent_session_id TEXT, agent TEXT NOT NULL, profile TEXT NOT NULL,
      cwd TEXT NOT NULL, permission_mode TEXT NOT NULL, title TEXT, status TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    raw.close();
    const db = openDb(file);
    const cols = (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("source_cursor");
  });
});
