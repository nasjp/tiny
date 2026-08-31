import readline from "node:readline";
import type { Readable, Writable } from "node:stream";

// Newline-delimited JSON-RPC 2.0 (one message per line). Both ACP (opencode acp etc.)
// and the Codex app-server use this same framing. No Content-Length header framing (verified unnecessary in practice).

export interface JsonRpcStreams {
  input: Readable;
  output: Writable;
}

export class JsonRpcRemoteError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "JsonRpcRemoteError";
  }
}

type RequestHandler = (params: unknown) => unknown | Promise<unknown>;
type NotificationHandler = (params: unknown) => void;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export class JsonRpcConnection {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private requestHandlers = new Map<string, RequestHandler>();
  private notificationHandlers = new Map<string, NotificationHandler>();
  private closeListeners: Array<() => void> = [];
  private closed = false;

  constructor(private streams: JsonRpcStreams) {
    const rl = readline.createInterface({ input: streams.input, crlfDelay: Infinity });
    rl.on("line", (line) => this.onLine(line));
    rl.on("close", () => this.onInputClosed());
    rl.on("error", () => this.onInputClosed());
    // A child process's stdin/stdout emit errors asynchronously (EPIPE etc.). Without a listener the whole
    // process crashes, so treat it as a connection close (killing the process is the caller's job)
    streams.input.on("error", () => this.onInputClosed());
    streams.output.on("error", () => this.onInputClosed());
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("json-rpc connection closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  /** Stop sending. Rejects all pending requests (killing the process is the caller's job) */
  close(): void {
    this.onInputClosed();
  }

  private write(msg: Record<string, unknown>): void {
    try {
      this.streams.output.write(JSON.stringify(msg) + "\n");
    } catch (err) {
      console.error("[json-rpc] write failed:", err);
    }
  }

  private onLine(line: string): void {
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // ignore non-JSON lines such as logs
    }
    if (!msg || typeof msg !== "object") return;
    if (typeof msg.method === "string") {
      if (msg.id !== undefined && msg.id !== null) void this.handleRequest(msg.id, msg.method, msg.params);
      else this.notificationHandlers.get(msg.method)?.(msg.params);
      return;
    }
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new JsonRpcRemoteError(Number(msg.error.code ?? -1), String(msg.error.message ?? "error"), msg.error.data));
      else p.resolve(msg.result);
    }
  }

  private async handleRequest(id: unknown, method: string, params: unknown): Promise<void> {
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not supported by tiny: ${method}` } });
      return;
    }
    try {
      const result = await handler(params);
      this.write({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (err) {
      this.write({ jsonrpc: "2.0", id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } });
    }
  }

  private onInputClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error("json-rpc connection closed"));
    this.pending.clear();
    for (const l of this.closeListeners) l();
  }
}
