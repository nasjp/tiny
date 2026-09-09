import { describe, expect, it } from "vitest";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import type { CodexProcess, CodexSpawn } from "../src/codex-adapter.js";
import { JsonRpcConnection } from "../src/jsonrpc-stdio.js";
import { deleteCodexQueued, queueCodexMessage } from "../src/codex-peer.js";

const TID = "01a08509-4d7c-78c1-8460-fd52c0e5a773";

/**
 * A stand-in for `codex app-server` answering only what codex-peer needs, in the shapes measured
 * on 0.153.4 (see the 2026-09-09 spec). `handle` decides each request's result or error
 */
function fakeAppServer(handle: (method: string, params: any) => { result?: unknown; error?: { code: number; message: string } } | "hang") {
  const received: Array<{ method: string; params: any }> = [];
  const spawned: Array<{ cwd: string; env: Record<string, string | undefined>; args: string[] }> = [];
  let killed = 0;
  const spawn: CodexSpawn = (launch, opts) => {
    spawned.push({ cwd: opts.cwd, env: opts.env, args: launch.args });
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    readline.createInterface({ input: toServer }).on("line", (line) => {
      const msg = JSON.parse(line);
      received.push({ method: msg.method, params: msg.params });
      if (msg.id === undefined) return; // initialized notification
      const r = handle(msg.method, msg.params);
      if (r === "hang") return;
      toClient.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...(r.error ? { error: r.error } : { result: r.result ?? null }) }) + "\n");
    });
    const conn = new JsonRpcConnection({ input: toClient, output: toServer });
    const proc: CodexProcess = { conn, kill: () => { killed++; conn.close(); }, stderrTail: () => "" };
    return proc;
  };
  return { spawn, received, spawned, killed: () => killed };
}

const init = { userAgent: "x", codexHome: "/h", platformFamily: "unix", platformOs: "macos" };

describe("codex-peer", () => {
  it("queues a message through thread/queue/add with tiny's own client id and the measured input shape", async () => {
    const fake = fakeAppServer((method, params) => {
      if (method === "initialize") return { result: init };
      if (method === "thread/queue/add") {
        return { result: { queuedSubmission: { id: "01a0850d-6d66-7412-8075-df9f415dc383", input: params.input, clientUserMessageId: params.clientUserMessageId } } };
      }
      return { error: { code: -32601, message: `unexpected ${method}` } };
    });
    const out = await queueCodexMessage("/home/cx", {
      threadId: TID, clientUserMessageId: "msg-1", text: "from the phone",
      images: [{ mediaType: "image/png", data: "AAAA" }],
    }, { spawn: fake.spawn });
    expect(out).toEqual({ queuedSubmissionId: "01a0850d-6d66-7412-8075-df9f415dc383" });
    expect(fake.received.map((r) => r.method)).toEqual(["initialize", "initialized", "thread/queue/add"]);
    expect(fake.received[2]!.params).toEqual({
      threadId: TID,
      clientUserMessageId: "msg-1",
      input: [{ type: "text", text: "from the phone" }, { type: "image", url: "data:image/png;base64,AAAA" }],
    });
    // CODEX_HOME points at the profile; API keys never reach codex (they would bill pay-as-you-go)
    expect(fake.spawned[0]!.env.CODEX_HOME).toBe("/home/cx");
    expect(fake.spawned[0]!.env.OPENAI_API_KEY).toBeUndefined();
    expect(fake.spawned[0]!.args).toEqual(["app-server"]);
    expect(fake.killed()).toBe(1); // one process per call, gone when the call is over
  });

  it("deletes a queued message and says whether it was still there", async () => {
    let deleted = true;
    const fake = fakeAppServer((method) => {
      if (method === "initialize") return { result: init };
      if (method === "thread/queue/delete") return { result: { deleted } };
      return { error: { code: -32601, message: `unexpected ${method}` } };
    });
    expect(await deleteCodexQueued("/home/cx", { threadId: TID, queuedSubmissionId: "q1" }, { spawn: fake.spawn })).toBe(true);
    expect(fake.received.at(-1)).toEqual({ method: "thread/queue/delete", params: { threadId: TID, queuedSubmissionId: "q1" } });
    deleted = false;
    expect(await deleteCodexQueued("/home/cx", { threadId: TID, queuedSubmissionId: "q1" }, { spawn: fake.spawn })).toBe(false);
    expect(fake.killed()).toBe(2);
  });

  it("surfaces codex's own error text and gives up on a process that never answers", async () => {
    const failing = fakeAppServer((method) => {
      if (method === "initialize") return { result: init };
      return { error: { code: -32603, message: `thread/queue/add failed: no rollout found for thread id ${TID}` } };
    });
    await expect(queueCodexMessage("/home/cx", { threadId: TID, clientUserMessageId: "m", text: "hi" }, { spawn: failing.spawn }))
      .rejects.toThrow(/no rollout found/);
    expect(failing.killed()).toBe(1);

    const hanging = fakeAppServer(() => "hang");
    await expect(queueCodexMessage("/home/cx", { threadId: TID, clientUserMessageId: "m", text: "hi" }, { spawn: hanging.spawn, timeoutMs: 30 }))
      .rejects.toThrow(/did not answer/);
    expect(hanging.killed()).toBe(1);
  });
});
