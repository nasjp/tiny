import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { JsonRpcConnection, JsonRpcRemoteError } from "../src/jsonrpc-stdio.js";

// The client's output = the peer's input (the peer reads the other end of the PassThrough)
function pair() {
  const toAgent = new PassThrough();
  const fromAgent = new PassThrough();
  const conn = new JsonRpcConnection({ input: fromAgent, output: toAgent });
  const agentLines: string[] = [];
  toAgent.on("data", (d) => {
    for (const l of String(d).split("\n")) if (l.trim() !== "") agentLines.push(l);
  });
  const agentSend = (msg: unknown) => fromAgent.write(JSON.stringify(msg) + "\n");
  const nextLine = () =>
    new Promise<Record<string, any>>((resolve) => {
      const tick = () => (agentLines.length > 0 ? resolve(JSON.parse(agentLines.shift()!)) : setTimeout(tick, 5));
      tick();
    });
  return { conn, agentSend, nextLine, fromAgent };
}

describe("JsonRpcConnection", () => {
  it("sends requests with an id and resolves on result", async () => {
    const { conn, agentSend, nextLine } = pair();
    const p = conn.request("initialize", { protocolVersion: 1 });
    const sent = await nextLine();
    expect(sent).toEqual({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    agentSend({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    await expect(p).resolves.toEqual({ ok: true });
  });

  it("rejects an error response with JsonRpcRemoteError", async () => {
    const { conn, agentSend, nextLine } = pair();
    const p = conn.request("session/new", {});
    await nextLine();
    agentSend({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "auth required", data: { x: 1 } } });
    await expect(p).rejects.toBeInstanceOf(JsonRpcRemoteError);
    await p.catch((e: JsonRpcRemoteError) => {
      expect(e.code).toBe(-32000);
      expect(e.message).toBe("auth required");
      expect(e.data).toEqual({ x: 1 });
    });
  });

  it("notify sends without an id", async () => {
    const { conn, nextLine } = pair();
    conn.notify("session/cancel", { sessionId: "s" });
    expect(await nextLine()).toEqual({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s" } });
  });

  it("answers a peer request with the handler's return value as result", async () => {
    const { conn, agentSend, nextLine } = pair();
    conn.onRequest("session/request_permission", async (params) => ({ outcome: { outcome: "selected", optionId: (params as any).options[0].optionId } }));
    agentSend({ jsonrpc: "2.0", id: 7, method: "session/request_permission", params: { options: [{ optionId: "once" }] } });
    expect(await nextLine()).toEqual({ jsonrpc: "2.0", id: 7, result: { outcome: { outcome: "selected", optionId: "once" } } });
  });

  it("returns -32601 for unregistered requests; a handler throw becomes -32603", async () => {
    const { conn, agentSend, nextLine } = pair();
    agentSend({ jsonrpc: "2.0", id: 1, method: "fs/read_text_file", params: {} });
    expect(await nextLine()).toMatchObject({ id: 1, error: { code: -32601 } });
    conn.onRequest("boom", () => { throw new Error("bad"); });
    agentSend({ jsonrpc: "2.0", id: 2, method: "boom", params: {} });
    expect(await nextLine()).toMatchObject({ id: 2, error: { code: -32603, message: "bad" } });
  });

  it("notifications reach the handler; non-JSON lines are ignored", async () => {
    const { conn, agentSend, fromAgent } = pair();
    const got: unknown[] = [];
    conn.onNotification("session/update", (p) => got.push(p));
    fromAgent.write("not json\n");
    agentSend({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "usage_update", used: 1, size: 2 } } });
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toEqual([{ sessionId: "s", update: { sessionUpdate: "usage_update", used: 1, size: 2 } }]);
  });

  it("closing the input rejects pending requests and calls onClose", async () => {
    const { conn, fromAgent } = pair();
    let closed = false;
    conn.onClose(() => (closed = true));
    const p = conn.request("session/prompt", {});
    fromAgent.end();
    await expect(p).rejects.toThrow(/closed/);
    expect(closed).toBe(true);
  });

  it("treats a stream error event as a connection close without killing the process", async () => {
    const { conn, fromAgent } = pair();
    let closed = false;
    conn.onClose(() => (closed = true));
    const p = conn.request("session/prompt", {});
    fromAgent.emit("error", new Error("EPIPE"));
    await expect(p).rejects.toThrow(/closed/);
    expect(closed).toBe(true);
  });

  it("also treats an output error event as a connection close", async () => {
    const toAgent = new PassThrough();
    const fromAgent = new PassThrough();
    const conn = new JsonRpcConnection({ input: fromAgent, output: toAgent });
    let closed = false;
    conn.onClose(() => (closed = true));
    toAgent.emit("error", new Error("EPIPE"));
    expect(closed).toBe(true);
    await expect(conn.request("x")).rejects.toThrow(/closed/);
  });
});
