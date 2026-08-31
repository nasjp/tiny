import { PassThrough } from "node:stream";
import readline from "node:readline";
import type { AgentLaunch } from "../src/agents/index.js";
import type { AcpProcess, AcpSpawn } from "../src/acp-adapter.js";
import { JsonRpcConnection } from "../src/jsonrpc-stdio.js";

export interface FakeAgentCtx {
  /** Sends a notification to the tiny side */
  notify(method: string, params: unknown): void;
  /** Sends a request to the tiny side and awaits the response (session/request_permission etc.) */
  request(method: string, params: unknown): Promise<any>;
  /** Log of requests received from the tiny side */
  received: Array<{ method: string; params: any }>;
  sessionId: string;
}

export interface FakeAgentScript {
  initialize?: Record<string, unknown>;
  /** Never responds to initialize (reproduces a startup hang) */
  hangInitialize?: boolean;
  /** The session/new response (besides sessionId). Defaults to {} */
  newSession?: Record<string, unknown>;
  /** Called on receiving session/prompt. Streams notifications, then returns a stopReason */
  onPrompt: (ctx: FakeAgentCtx, params: any) => Promise<Record<string, unknown>>;
  /** Called on receiving session/cancel. Default makes the prompt return cancelled */
  onCancel?: (ctx: FakeAgentCtx) => void;
  /** The session/set_config_option response. Defaults to { configOptions: [] } */
  onSetConfig?: (params: any) => Record<string, unknown>;
  /** Called before responding to session/load (to stream the replayed notifications) */
  onLoad?: (ctx: FakeAgentCtx) => void;
  /**
   * If true, fails session/new / session/resume / session/load with -32000
   * (Authentication required) until authenticate is received (reproduces droid / cursor measurements)
   */
  requireAuthUntilAuthenticated?: boolean;
}

export interface FakeAgent {
  spawn: AcpSpawn;
  received: Array<{ method: string; params: any }>;
  spawned: Array<{ launch: AgentLaunch; cwd: string; env: Record<string, string | undefined> }>;
  killed: number;
  /** Answers a prompt awaiting cancel with cancelled (the default onCancel) */
  cancelPending(): void;
}

const DEFAULT_INIT = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: true, embeddedContext: true },
    mcpCapabilities: { http: true, sse: true },
    sessionCapabilities: { resume: {}, fork: {}, list: {}, close: {} },
  },
  authMethods: [{ id: "opencode-login", name: "Login with opencode" }],
  agentInfo: { name: "FakeAgent", version: "0" },
};

/**
 * Fake ACP agent facing tiny's JsonRpcConnection over two PassThrough streams.
 * Responses match measurements of real opencode 1.18.18 (HANDOFF "OpenCode ACP measurements").
 */
export function fakeAcpAgent(script: FakeAgentScript): FakeAgent {
  const fake: FakeAgent = {
    received: [],
    spawned: [],
    killed: 0,
    cancelPending: () => {},
    spawn: (launch, opts) => {
      fake.spawned.push({ launch, cwd: opts.cwd, env: opts.env });
      const toAgent = new PassThrough();
      const fromAgent = new PassThrough();
      const conn = new JsonRpcConnection({ input: fromAgent, output: toAgent });
      const send = (msg: unknown) => fromAgent.write(JSON.stringify(msg) + "\n");
      let nextId = 1000;
      const pending = new Map<number, (v: any) => void>();
      const sessionId = "ses_fake1";
      let cancelPrompt: ((r: Record<string, unknown>) => void) | null = null;
      let authenticated = false;
      const ctx: FakeAgentCtx = {
        received: fake.received,
        sessionId,
        notify: (method, params) => send({ jsonrpc: "2.0", method, params }),
        request: (method, params) =>
          new Promise((resolve) => {
            const id = nextId++;
            pending.set(id, resolve);
            send({ jsonrpc: "2.0", id, method, params });
          }),
      };
      fake.cancelPending = () =>
        cancelPrompt?.({ stopReason: "cancelled", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } });

      const rl = readline.createInterface({ input: toAgent });
      rl.on("line", (line) => {
        const msg = JSON.parse(line);
        if (msg.method === undefined) {
          pending.get(msg.id)?.(msg.result ?? msg.error);
          pending.delete(msg.id);
          return;
        }
        fake.received.push({ method: msg.method, params: msg.params });
        const reply = (result: unknown) => send({ jsonrpc: "2.0", id: msg.id, result });
        const replyAuthError = () =>
          send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "Authentication required" } });
        const needsAuth = () => script.requireAuthUntilAuthenticated === true && !authenticated;
        switch (msg.method) {
          case "initialize":
            if (script.hangInitialize) break; // no response (reproduces a startup hang)
            reply(script.initialize ?? DEFAULT_INIT);
            break;
          case "session/new":
            if (needsAuth()) {
              replyAuthError();
              break;
            }
            reply({ sessionId, ...(script.newSession ?? {}) });
            break;
          case "session/resume":
            if (needsAuth()) {
              replyAuthError();
              break;
            }
            reply({});
            break;
          case "session/load":
            if (needsAuth()) {
              replyAuthError();
              break;
            }
            script.onLoad?.(ctx);
            reply({});
            break;
          case "authenticate":
            authenticated = true;
            reply({});
            break;
          case "session/set_config_option":
            try {
              reply(script.onSetConfig?.(msg.params) ?? { configOptions: [] });
            } catch (err) {
              send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: err instanceof Error ? err.message : String(err) } });
            }
            break;
          case "session/prompt": {
            let done = false;
            cancelPrompt = (r) => {
              if (!done) {
                done = true;
                reply(r);
              }
            };
            void script.onPrompt(ctx, msg.params).then((r) => {
              if (!done) {
                done = true;
                reply(r);
              }
            });
            break;
          }
          case "session/cancel":
            if (script.onCancel) script.onCancel(ctx);
            else fake.cancelPending();
            break;
          default:
            send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `fake agent: ${msg.method}` } });
        }
      });
      const proc: AcpProcess = {
        conn,
        kill: () => {
          fake.killed += 1;
          fromAgent.end();
        },
        stderrTail: () => "",
      };
      return proc;
    },
  };
  return fake;
}
