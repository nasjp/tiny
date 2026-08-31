import readline from "node:readline";
import { PassThrough } from "node:stream";
import type { CodexProcess, CodexSpawn } from "../src/codex-adapter.js";
import type { AgentLaunch } from "../src/agents/index.js";
import { JsonRpcConnection } from "../src/jsonrpc-stdio.js";

export interface FakeCodexCtx {
  /** Sends a notification to the tiny side */
  notify(method: string, params: unknown): void;
  /** Sends a request to the tiny side and awaits the response (requestApproval / requestUserInput) */
  request(method: string, params: unknown): Promise<any>;
  /** Log of requests / notifications received from the tiny side */
  received: Array<{ method: string; params: any }>;
  threadId: string;
  turnId: string;
  /** Sends turn/completed at an arbitrary moment */
  complete(turn: Record<string, unknown>): void;
  /** Reproduces the codex process dying suddenly (crash/SIGKILL etc.) by closing stdout */
  die(): void;
}

export interface FakeCodexScript {
  /** The initialize response (defaults to the measured shape) */
  initialize?: Record<string, unknown>;
  /** Never responds to initialize (reproduces a startup hang) */
  hangInitialize?: boolean;
  /** Extra fields mixed into the thread of thread/start */
  thread?: Record<string, unknown>;
  /** Past turns carried on the thread/resume response */
  resumeTurns?: unknown[];
  /**
   * Called on receiving turn/start. Stream notifications and return a turn to get turn/completed.
   * A turn that returns null never finishes until ctx.complete() is called (reproduces a stall)
   */
  onTurn: (ctx: FakeCodexCtx, params: any) => Promise<Record<string, unknown> | null>;
  /** If true, runs onTurn before the turn/start response (reproduces measured notifications overtaking the response) */
  turnBeforeResponse?: boolean;
  /** Behavior on receiving turn/interrupt. Default sends turn/completed(interrupted) */
  onInterrupt?: (ctx: FakeCodexCtx) => void;
  /** The account/rateLimits/read response */
  rateLimits?: unknown;
  /**
   * Delays the thread/start / thread/resume responses (for same-profileDir serialization tests).
   * No response until the returned Promise resolves.
   */
  delayThreadStart?: () => Promise<void>;
  /**
   * `mcpServer/startupStatus/updated` streamed right after the thread/start / thread/resume response (measured shape).
   * - "ready" (default): codex_apps ready → tiny starting → tiny ready
   * - "failed": codex_apps ready → tiny starting → tiny failed (with error / failureReason)
   * - "none": streams nothing (reproduces a codex without startupStatus / a turn without MCP)
   */
  mcpStartup?: "ready" | "failed" | "none";
}

export interface FakeCodexServer {
  spawn: CodexSpawn;
  received: Array<{ method: string; params: any }>;
  spawned: Array<{ launch: AgentLaunch; cwd: string; env: Record<string, string | undefined> }>;
  killed: number;
}

const DEFAULT_INIT = {
  userAgent: "codex/0.149.1",
  codexHome: "/tmp/codex-home",
  platformFamily: "unix",
  platformOs: "macos",
};

const THREAD_ID = "thr_fake1";
const TURN_ID = "turn_1";

/**
 * Fake `codex app-server` facing tiny's JsonRpcConnection over two PassThrough streams.
 * Responses match the measured shapes (HANDOFF "Codex app-server measurements", codex-cli 0.149.1).
 */
export function fakeCodexServer(script: FakeCodexScript): FakeCodexServer {
  const fake: FakeCodexServer = {
    received: [],
    spawned: [],
    killed: 0,
    spawn: (launch, opts) => {
      fake.spawned.push({ launch, cwd: opts.cwd, env: opts.env });
      const toServer = new PassThrough();
      const fromServer = new PassThrough();
      const conn = new JsonRpcConnection({ input: fromServer, output: toServer });
      let alive = true;
      const send = (msg: unknown) => {
        if (alive) fromServer.write(JSON.stringify(msg) + "\n");
      };
      let nextId = 1000;
      const pending = new Map<number, (v: any) => void>();
      let threadId = THREAD_ID;
      const ctx: FakeCodexCtx = {
        received: fake.received,
        get threadId() {
          return threadId;
        },
        turnId: TURN_ID,
        notify: (method, params) => send({ jsonrpc: "2.0", method, params }),
        request: (method, params) =>
          new Promise((resolve) => {
            const id = nextId++;
            pending.set(id, resolve);
            send({ jsonrpc: "2.0", id, method, params });
          }),
        complete: (turn) => send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId, turn } }),
        die: () => {
          alive = false;
          fromServer.end(); // closes tiny's input stream = mimics the child dying with stdout closed
        },
      };

      // Measured: at thread start the MCP servers in config.toml are launched, and each server
      // notifies starting → ready (failed on failure)
      const notifyMcpStartup = () => {
        const mode = script.mcpStartup ?? "ready";
        if (mode === "none") return;
        ctx.notify("mcpServer/startupStatus/updated", { threadId, name: "codex_apps", status: "ready" });
        ctx.notify("mcpServer/startupStatus/updated", { threadId, name: "tiny", status: "starting" });
        if (mode === "failed") {
          ctx.notify("mcpServer/startupStatus/updated", {
            threadId,
            name: "tiny",
            status: "failed",
            error: "spawn failed",
            failureReason: "startupFailed",
          });
        } else {
          ctx.notify("mcpServer/startupStatus/updated", { threadId, name: "tiny", status: "ready" });
        }
      };

      const rl = readline.createInterface({ input: toServer });
      rl.on("line", (line) => {
        const msg = JSON.parse(line);
        if (msg.method === undefined) {
          pending.get(msg.id)?.(msg.result ?? msg.error);
          pending.delete(msg.id);
          return;
        }
        fake.received.push({ method: msg.method, params: msg.params });
        const reply = (result: unknown) => send({ jsonrpc: "2.0", id: msg.id, result });
        switch (msg.method) {
          case "initialize":
            if (script.hangInitialize) break; // no response
            reply(script.initialize ?? DEFAULT_INIT);
            // Measured: an ignorable notification arriving right after initialize
            ctx.notify("remoteControl/status/changed", { status: "idle" });
            ctx.notify("mcpServer/startupStatus/updated", { server: "codex_apps", status: "starting" });
            break;
          case "initialized":
            break; // a notification (no response needed)
          case "thread/start":
            void (script.delayThreadStart?.() ?? Promise.resolve()).then(() => {
              reply({
                thread: { id: threadId, cwd: msg.params?.cwd, turns: [], ...(script.thread ?? {}) },
                model: msg.params?.model ?? "gpt-5.6-sol",
                approvalPolicy: msg.params?.approvalPolicy,
                sandbox: msg.params?.sandbox,
              });
              notifyMcpStartup();
            });
            break;
          case "thread/resume":
            threadId = msg.params?.threadId ?? threadId;
            void (script.delayThreadStart?.() ?? Promise.resolve()).then(() => {
              reply({
                thread: {
                  id: threadId,
                  cwd: msg.params?.cwd,
                  turns: script.resumeTurns ?? [{ id: "turn_0", items: [], itemsView: "full", status: "completed" }],
                },
                model: "gpt-5.6-sol",
              });
              notifyMcpStartup();
            });
            break;
          case "turn/start": {
            const run = () =>
              void script.onTurn(ctx, msg.params).then((turn) => {
                if (turn) ctx.complete(turn);
              });
            if (script.turnBeforeResponse) {
              run();
              reply({ turn: { id: TURN_ID, status: "inProgress", items: [] } });
            } else {
              reply({ turn: { id: TURN_ID, status: "inProgress", items: [] } });
              run();
            }
            break;
          }
          case "turn/interrupt":
            reply({});
            if (script.onInterrupt) script.onInterrupt(ctx);
            else ctx.complete({ id: TURN_ID, status: "interrupted", items: [] });
            break;
          case "account/rateLimits/read":
            reply(script.rateLimits ?? {});
            break;
          default:
            send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `fake codex: ${msg.method}` } });
        }
      });

      const proc: CodexProcess = {
        conn,
        kill: () => {
          fake.killed += 1;
          alive = false;
          fromServer.end();
        },
        stderrTail: () => "",
      };
      return proc;
    },
  };
  return fake;
}
