import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/server.js";
import { addProfile } from "../src/profiles.js";

describe("WS stream", () => {
  let home: string;
  let cwd: string;
  let srv: Awaited<ReturnType<typeof startServer>>;

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-ws-"));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-ws-cwd-"));
    addProfile(path.join(home, "profiles"), "work");
    srv = await startServer({ TINY_HOME: home, TINY_PORT: "0" });
  });

  afterEach(async () => {
    await srv.close();
  });

  it("since replay and live delivery", async () => {
    const token = srv.auth.cliToken();
    const sess = srv.manager.createSession({ profile: "work", cwd });
    // Persist 2 prior events (the backlog)
    srv.manager.setDetached(sess.id, true);
    srv.manager.setDetached(sess.id, false);

    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/v1/sessions/${sess.id}/stream?token=${token}&since=0`);
    const received: Array<{ id: number; type: string }> = [];
    ws.addEventListener("message", (ev) => received.push(JSON.parse(String(ev.data))));
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("ws error")));
    });
    // Wait until both backlog events are received
    await vi_waitUntil(() => received.length >= 2);
    expect(received.map((e) => e.type)).toEqual(["session_state_changed", "session_state_changed"]);

    // Live: new events stream in
    srv.manager.setDetached(sess.id, true);
    await vi_waitUntil(() => received.length >= 3);
    expect(received[2]!.id).toBeGreaterThan(received[1]!.id);
    ws.close();
  });

  it("rejects connections without a token", async () => {
    const sess = srv.manager.createSession({ profile: "work", cwd });
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/v1/sessions/${sess.id}/stream`);
    // Node 22's built-in WebSocket has known behavior of not firing `close` on a non-101 rejection
    // (only `error` fires and readyState stays stuck at CONNECTING), so the server is designed to
    // complete the handshake and then close with the auth-failure code (4401). Verify the `close`
    // event and its code here.
    const closeCode = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("close event timeout")), 5000);
      ws.addEventListener("close", (ev) => {
        clearTimeout(timer);
        resolve(ev.code);
      });
    });
    expect(closeCode).toBe(4401);
  });
});

async function vi_waitUntil(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}
