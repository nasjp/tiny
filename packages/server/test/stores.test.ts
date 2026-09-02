import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { createStores, type Stores } from "../src/stores.js";
import type { SessionRecord } from "../src/types.js";

function fixture(over: Partial<SessionRecord> = {}): SessionRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    agentSessionId: null,
    agent: "claude",
    profile: "work",
    cwd: "/tmp",
    permissionMode: "default",
    model: null, effort: null,
    title: null,
    status: "idle",
    archivedAt: null,
    sourceCursor: null,
    cliClosedAt: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

describe("stores", () => {
  let s: Stores;
  beforeEach(() => {
    s = createStores(openDb(":memory:"));
  });

  it("sessions: create/get/list/patch", () => {
    const rec = fixture();
    s.sessions.create(rec);
    expect(s.sessions.get(rec.id)?.profile).toBe("work");
    expect(s.sessions.list()).toHaveLength(1);
    expect(s.sessions.list("running")).toHaveLength(0);
    s.sessions.patch(rec.id, { status: "running", agentSessionId: "abc", title: "t" });
    const got = s.sessions.get(rec.id)!;
    expect(got.status).toBe("running");
    expect(got.agentSessionId).toBe("abc");
    expect(got.title).toBe("t");
    expect(got.updatedAt >= rec.updatedAt).toBe(true);
  });

  it("sessions: list excludes archived and flips with archived=true", () => {
    const normal = fixture();
    const archived = fixture({ archivedAt: new Date().toISOString() });
    s.sessions.create(normal);
    s.sessions.create(archived);
    expect(s.sessions.list().map((x) => x.id)).toEqual([normal.id]);
    expect(s.sessions.list(undefined, true).map((x) => x.id)).toEqual([archived.id]);
    // Combined with the status filter
    expect(s.sessions.list("idle")).toHaveLength(1);
    expect(s.sessions.list("idle", true)).toHaveLength(1);
  });

  it("sessions: patch can set archivedAt and revert it with null", () => {
    const rec = fixture();
    s.sessions.create(rec);
    s.sessions.patch(rec.id, { archivedAt: "2026-08-28T00:00:00.000Z" });
    expect(s.sessions.get(rec.id)?.archivedAt).toBe("2026-08-28T00:00:00.000Z");
    // A patch without archivedAt leaves it unchanged
    s.sessions.patch(rec.id, { title: "t" });
    expect(s.sessions.get(rec.id)?.archivedAt).toBe("2026-08-28T00:00:00.000Z");
    s.sessions.patch(rec.id, { archivedAt: null });
    expect(s.sessions.get(rec.id)?.archivedAt).toBeNull();
  });

  it("events: append assigns sequential ids and listSince can resend", () => {
    const e1 = s.events.append("sess1", "turn_started", { a: 1 });
    const e2 = s.events.append("sess1", "assistant_text", { text: "hi" });
    s.events.append("sess2", "turn_started", {});
    expect(e2.id).toBeGreaterThan(e1.id);
    expect(s.events.listSince("sess1", 0)).toHaveLength(2);
    expect(s.events.listSince("sess1", e1.id)).toHaveLength(1);
    expect(s.events.listSince("sess1", e1.id)[0]!.payload).toEqual({ text: "hi" });
  });

  it("devices: insert/byToken/setApnsToken", () => {
    s.devices.insert({
      id: "d1", name: "iPhone", bearerToken: "tok1",
      apnsToken: null, apnsEnv: "production", e2eKey: "k", createdAt: new Date().toISOString(),
    });
    expect(s.devices.byToken("tok1")?.id).toBe("d1");
    expect(s.devices.byToken("nope")).toBeNull();
    s.devices.setApnsToken("d1", "apns-x", "sandbox");
    expect(s.devices.byToken("tok1")?.apnsToken).toBe("apns-x");
  });

  it("devices: delete removes the row and invalidates the bearer", () => {
    s.devices.insert({
      id: "d2", name: "old iPhone", bearerToken: "tok2",
      apnsToken: null, apnsEnv: "sandbox", e2eKey: "k", createdAt: new Date().toISOString(),
    });
    expect(s.devices.delete("d2")).toBe(true);
    expect(s.devices.byId("d2")).toBeNull();
    expect(s.devices.byToken("tok2")).toBeNull();
    expect(s.devices.delete("d2")).toBe(false);   // double delete is false
  });

  it("files: insert/get", () => {
    s.files.insert({
      id: "f1", sessionId: "sess1", originalPath: "/a.html",
      storedPath: "/outbox/f1", mime: "text/html", caption: null,
      createdAt: new Date().toISOString(),
    });
    expect(s.files.get("f1")?.mime).toBe("text/html");
    expect(s.files.get("nope")).toBeNull();
  });

  it("pairings: take succeeds exactly once and fails when expired", () => {
    s.pairings.put("CODE1", new Date(Date.now() + 60_000).toISOString());
    expect(s.pairings.take("CODE1")).toBe(true);
    expect(s.pairings.take("CODE1")).toBe(false);
    s.pairings.put("OLD", new Date(Date.now() - 1000).toISOString());
    expect(s.pairings.take("OLD")).toBe(false);
  });

  it("finds a session by agentSessionId and deletes it", () => {
    const rec = {
      id: "s1", agentSessionId: "agent-1", agent: "claude", profile: "work",
      cwd: "/tmp", permissionMode: "default", model: null, effort: null, title: null,
      status: "idle" as const, archivedAt: null, sourceCursor: null, cliClosedAt: null,
      createdAt: "2026-08-31T00:00:00.000Z", updatedAt: "2026-08-31T00:00:00.000Z",
    };
    s.sessions.create(rec);
    expect(s.sessions.byAgentSessionId("agent-1")?.id).toBe("s1");
    expect(s.sessions.byAgentSessionId("nope")).toBeNull();
    expect(s.sessions.delete("s1")).toBe(true);
    expect(s.sessions.delete("s1")).toBe(false);
    expect(s.sessions.get("s1")).toBeNull();
  });

  it("round-trips sourceCursor through create and patch", () => {
    const rec = {
      id: "s2", agentSessionId: null, agent: "claude", profile: "work",
      cwd: "/tmp", permissionMode: "default", model: null, effort: null, title: null,
      status: "idle" as const, archivedAt: null, sourceCursor: null, cliClosedAt: null,
      createdAt: "2026-08-31T00:00:00.000Z", updatedAt: "2026-08-31T00:00:00.000Z",
    };
    s.sessions.create(rec);
    expect(s.sessions.get("s2")?.sourceCursor).toBeNull();
    s.sessions.patch("s2", { sourceCursor: "uuid-9" });
    expect(s.sessions.get("s2")?.sourceCursor).toBe("uuid-9");
  });

  it("counts events per session", () => {
    expect(s.events.count("s3")).toBe(0);
    s.events.append("s3", "user_message", { text: "hi" });
    s.events.append("s3", "assistant_text", { text: "yo" });
    expect(s.events.count("s3")).toBe(2);
  });

  it("setCliClosedAt writes the mark without touching updated_at, and patch keeps it", () => {
    const rec = fixture({ updatedAt: "2026-09-02T10:00:00.000Z" });
    s.sessions.create(rec);
    expect(s.sessions.get(rec.id)?.cliClosedAt).toBeNull();

    s.sessions.setCliClosedAt(rec.id, "2026-09-02T12:00:00.000Z");
    const closed = s.sessions.get(rec.id)!;
    expect(closed.cliClosedAt).toBe("2026-09-02T12:00:00.000Z");
    // Closing is not conversation activity: the list must not reorder, the unread dot must stay off
    expect(closed.updatedAt).toBe("2026-09-02T10:00:00.000Z");

    // An unrelated patch (title / model / status) leaves the mark alone
    s.sessions.patch(rec.id, { title: "renamed" });
    expect(s.sessions.get(rec.id)?.cliClosedAt).toBe("2026-09-02T12:00:00.000Z");

    s.sessions.setCliClosedAt(rec.id, null);
    expect(s.sessions.get(rec.id)?.cliClosedAt).toBeNull();
    expect(() => s.sessions.setCliClosedAt("missing", null)).toThrow(/not found/);
  });
});

describe("devices store", () => {
  it("supports list, get, token update, and revocation", () => {
    const stores = createStores(openDb(":memory:"));
    stores.devices.insert({
      id: "dev-1", name: "iPhone", bearerToken: "tok-1", apnsToken: null,
      apnsEnv: "production", e2eKey: "a".repeat(44), createdAt: new Date().toISOString(),
    });
    expect(stores.devices.list()).toHaveLength(1);
    expect(stores.devices.byId("dev-1")?.name).toBe("iPhone");
    expect(stores.devices.byId("missing")).toBeNull();

    stores.devices.setApnsToken("dev-1", "b".repeat(64), "sandbox");
    expect(stores.devices.byId("dev-1")?.apnsToken).toBe("b".repeat(64));
    expect(stores.devices.byId("dev-1")?.apnsEnv).toBe("sandbox");

    stores.devices.clearApnsToken("dev-1");
    expect(stores.devices.byId("dev-1")?.apnsToken).toBeNull();
    // The env is kept (the next re-registration from the same build gets the same env)
    expect(stores.devices.byId("dev-1")?.apnsEnv).toBe("sandbox");
  });

  it("opens an existing DB lacking the apns_env column via migration", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tiny-mig-")), "old.db");
    const legacy = new Database(file);
    legacy.exec(`CREATE TABLE devices (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, bearer_token TEXT NOT NULL UNIQUE,
      apns_token TEXT, e2e_key TEXT NOT NULL, created_at TEXT NOT NULL)`);
    legacy.prepare(`INSERT INTO devices VALUES (?,?,?,?,?,?)`)
      .run("old-1", "old device", "tok-old", null, "k", new Date().toISOString());
    legacy.close();

    const stores = createStores(openDb(file));
    expect(stores.devices.byId("old-1")?.apnsEnv).toBe("production");
  });
});

describe("stores: recentCwds", () => {
  let s: Stores;
  beforeEach(() => {
    s = createStores(openDb(":memory:"));
  });

  it("returns cwds deduplicated, newest last-use first (including archived)", () => {
    s.sessions.create(fixture({ cwd: "/a", updatedAt: "2026-01-01T00:00:00.000Z" }));
    s.sessions.create(fixture({ cwd: "/b", updatedAt: "2026-01-02T00:00:00.000Z", archivedAt: "2026-01-03T00:00:00.000Z" }));
    s.sessions.create(fixture({ cwd: "/a", updatedAt: "2026-01-04T00:00:00.000Z" }));
    s.sessions.create(fixture({ cwd: "/c", updatedAt: "2026-01-03T00:00:00.000Z" }));
    expect(s.sessions.recentCwds()).toEqual(["/a", "/c", "/b"]);
  });
});
