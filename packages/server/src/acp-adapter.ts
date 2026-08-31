import { spawn as nodeSpawn } from "node:child_process";
import type { AgentAdapter, RunTurnParams, TurnResult } from "./adapter.js";
import { agentEnv, type AgentDriver, type AgentLaunch } from "./agents/index.js";
import { JsonRpcConnection, JsonRpcRemoteError } from "./jsonrpc-stdio.js";
import type { PermissionDecision } from "./permission-broker.js";
import { oneLine, type ToolHint, type ToolKind } from "./tool-kinds.js";
import { TINY_VERSION } from "./version.js";

// Generic adapter for ACP (Agent Client Protocol). Agents that speak ACP over stdio, such as
// opencode acp / gemini --experimental-acp / cursor-agent acp, work with just a driver definition (launch).
// Source of truth for the mapping: HANDOFF "OpenCode ACP measurements" and docs/superpowers/plans/2026-08-29-phase-c-agents.md.
// A process is spawned per turn; from the second turn on, continue with session/resume (or session/load if absent).

export interface AcpProcess {
  conn: JsonRpcConnection;
  kill(): void;
  /** Tail of stderr to append to error messages */
  stderrTail(): string;
}

export type AcpSpawn = (launch: AgentLaunch, opts: { cwd: string; env: Record<string, string | undefined> }) => AcpProcess;

/** Real implementation: spawns a child process and speaks JSON-RPC over stdin/stdout */
export const spawnAcpProcess: AcpSpawn = (launch, opts) => {
  const child = nodeSpawn(launch.command, launch.args, { cwd: opts.cwd, env: opts.env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
  const stderr: string[] = [];
  child.stderr.on("data", (d) => {
    stderr.push(String(d));
    if (stderr.length > 50) stderr.shift();
  });
  child.on("error", (err) => stderr.push(`spawn error: ${err.message}`));
  const conn = new JsonRpcConnection({ input: child.stdout, output: child.stdin });
  child.on("exit", () => conn.close());
  return {
    conn,
    kill: () => {
      if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
    },
    stderrTail: () => stderr.join("").split("\n").filter((l) => l.trim() !== "").slice(-5).join("\n"),
  };
};

const TOOL_KINDS: readonly ToolKind[] = ["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "question", "other"];

function toKind(kind: unknown): ToolKind {
  return typeof kind === "string" && (TOOL_KINDS as readonly string[]).includes(kind) ? (kind as ToolKind) : "other";
}

interface AcpCaps {
  loadSession?: boolean;
  promptCapabilities?: { image?: boolean };
  sessionCapabilities?: { resume?: unknown };
}

interface AcpToolCall {
  toolCallId: string;
  title?: string | null;
  name?: string | null;
  kind?: string | null;
  status?: string | null;
  rawInput?: unknown;
}

interface PermissionOption {
  optionId: string;
  kind: string;
  name: string;
}

type SessionUpdate = Record<string, any> & { sessionUpdate: string };

/** name if it is a non-empty string, else title if it is a non-empty string, else "tool" */
function toolNameOf(tc: { name?: string | null; title?: string | null }): string {
  if (typeof tc.name === "string" && tc.name !== "") return tc.name;
  if (typeof tc.title === "string" && tc.title !== "") return tc.title;
  return "tool";
}

export class AcpAdapter implements AgentAdapter {
  private spawn: AcpSpawn;
  private cancelTimeoutMs: number;

  constructor(
    private driver: AgentDriver,
    opts: { spawn?: AcpSpawn; cancelTimeoutMs?: number } = {},
  ) {
    if (!driver.launch) throw new Error(`agent ${driver.id} has no launch command (adapter: acp)`);
    this.spawn = opts.spawn ?? spawnAcpProcess;
    this.cancelTimeoutMs = opts.cancelTimeoutMs ?? 5000;
  }

  async runTurn(p: RunTurnParams): Promise<TurnResult> {
    // Reject an abort before turn_started (before spawning the process) here. Once turn_started is emitted, never throw again
    if (p.signal.aborted) throw new Error(`${this.driver.label} turn was interrupted before it started`);
    const launch = this.driver.launch!;
    const proc = this.spawn(launch, { cwd: p.cwd, env: agentEnv(this.driver, p.profileDir) });
    const conn = proc.conn;
    const label = this.driver.label;
    const cancelTimeoutMs = this.cancelTimeoutMs;

    // --- per-turn state ---
    let sessionId: string | null = null;
    let replaying = false; // discard notifications while session/load replays history
    let textBuf = "";
    let thoughtBuf = "";
    const texts: string[] = [];
    const started = new Map<string, { toolName: string }>();
    const finished = new Set<string>();
    let contextTokens: number | null = null;
    let costUsd: number | null = null;
    let aborted = false;
    const abortWaiters: Array<() => void> = [];
    // Fires immediately if already aborted at registration time (never misses an abort that happened before the waiter was registered)
    const onAborted = (fn: () => void) => {
      if (aborted) fn();
      else abortWaiters.push(fn);
    };

    const flushText = () => {
      if (textBuf === "") return;
      texts.push(textBuf);
      p.emit({ type: "assistant_text", payload: { text: textBuf } });
      textBuf = "";
    };
    // The model's reasoning narration (measured on opencode 1.18: streamed in pieces, with a
    // trailing empty chunk). Shown like Claude's thinking line; never part of resultText/the push
    const flushThought = () => {
      if (thoughtBuf.trim() === "") {
        thoughtBuf = "";
        return;
      }
      p.emit({ type: "assistant_thinking", payload: { text: thoughtBuf } });
      thoughtBuf = "";
    };
    const finish = (id: string, isError: boolean) => {
      if (finished.has(id)) return;
      finished.add(id);
      p.emit({ type: "tool_finished", payload: { toolUseId: id, isError } });
    };
    const isTerminal = (status: unknown) => status === "completed" || status === "failed";
    const startTool = (tc: AcpToolCall) => {
      flushText();
      const toolName = toolNameOf(tc);
      started.set(tc.toolCallId, { toolName });
      p.emit({
        type: "tool_started",
        payload: {
          toolUseId: tc.toolCallId,
          toolName,
          input: tc.rawInput && typeof tc.rawInput === "object" ? tc.rawInput : {},
          kind: toKind(tc.kind),
          summary: oneLine(tc.title || toolName),
        },
      });
    };

    // Each chunk arrival flushes the OTHER buffer, so at most one of textBuf / thoughtBuf is ever
    // non-empty and interleaved thought → answer → thought sequences come out in arrival order
    const onUpdate = (u: SessionUpdate) => {
      switch (u.sessionUpdate) {
        case "agent_message_chunk":
          if (u.content?.type === "text" && typeof u.content.text === "string") {
            flushThought();
            textBuf += u.content.text;
          }
          break;
        case "agent_thought_chunk":
          if (u.content?.type === "text" && typeof u.content.text === "string") {
            flushText();
            thoughtBuf += u.content.text;
          }
          break;
        case "tool_call":
        case "tool_call_update": {
          flushThought(); // a narration that led into this tool goes out before the tool card

          const tc = u as AcpToolCall & SessionUpdate;
          if (!started.has(tc.toolCallId)) startTool(tc); // some agents omit tool_call
          if (isTerminal(tc.status)) finish(tc.toolCallId, tc.status === "failed");
          break;
        }
        case "usage_update":
          if (typeof u.used === "number") contextTokens = u.used;
          if (typeof u.cost?.amount === "number") costUsd = u.cost.amount;
          break;
        default:
          break; // plan / available_commands / mode / config are dropped in v1
      }
    };
    conn.onNotification("session/update", (params) => {
      const n = params as { sessionId?: string; update?: SessionUpdate };
      if (replaying || !n?.update) return;
      onUpdate(n.update);
    });

    conn.onRequest("session/request_permission", async (params) => {
      const req = params as { toolCall: AcpToolCall; options: PermissionOption[] };
      const tc = req.toolCall ?? ({ toolCallId: "" } as AcpToolCall);
      const options = Array.isArray(req.options) ? req.options : [];
      const pick = (kinds: string[]) => kinds.map((k) => options.find((o) => o.kind === k)).find((o) => o !== undefined);
      const toolName = started.get(tc.toolCallId)?.toolName ?? toolNameOf(tc);
      const hint: ToolHint = { kind: toKind(tc.kind), summary: oneLine(tc.title || toolName) };
      let decision: PermissionDecision;
      if (p.permissionMode === "auto") {
        decision = { behavior: "allow" };
      } else {
        const cancelled = new Promise<null>((resolve) => onAborted(() => resolve(null)));
        const d = await Promise.race([p.requestPermission(toolName, tc.rawInput ?? {}, hint), cancelled]);
        if (d === null) return { outcome: { outcome: "cancelled" } };
        decision = d;
      }
      const opt = decision.behavior === "allow" ? pick(["allow_once", "allow_always"]) : pick(["reject_once", "reject_always"]);
      if (!opt) return { outcome: { outcome: "cancelled" } };
      return { outcome: { outcome: "selected", optionId: opt.optionId } };
    });

    // If the process dies first, the request gets rejected (append stderr to make the message meaningful)
    const withExit = async <T>(work: Promise<T>, what: string): Promise<T> => {
      try {
        return await work;
      } catch (err) {
        const tail = proc.stderrTail();
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`${label} ${what} failed: ${msg}${tail ? `\n${tail}` : ""}`);
      }
    };

    const onAbort = () => {
      aborted = true;
      for (const w of abortWaiters.splice(0)) w();
      if (sessionId) conn.notify("session/cancel", { sessionId });
    };
    p.signal.addEventListener("abort", onAbort);

    // An abort during startup (before turn_started) cannot send session/cancel yet, so wrap
    // initialize / session/new / session/resume / session/load / session/set_config_option
    // in this race and bail out with an immediate throw (throwing is correct before turn_started)
    let rejectStartupAbort: (() => void) | null = null;
    const abortedDuringStartup = new Promise<never>((_, reject) => {
      rejectStartupAbort = () => reject(new Error(`${label} interrupted before the turn started`));
    });
    abortedDuringStartup.catch(() => {}); // avoid an unhandled rejection if it ends up unused
    onAborted(() => rejectStartupAbort!());
    const raceStartup = <T>(work: Promise<T>): Promise<T> => Promise.race([work, abortedDuringStartup]);

    // If session/new, session/resume, or session/load fails with -32000 (auth required) or an
    // auth-related message, authenticate (when authMethods exist) and retry the same request exactly once
    // (measured on droid and cursor: unauthenticated calls fail with Authentication required and pass after authenticate)
    const isAuthError = (err: unknown): boolean => {
      const code = err instanceof JsonRpcRemoteError ? err.code : undefined;
      const message = err instanceof Error ? err.message : String(err);
      return code === -32000 || /auth/i.test(message);
    };
    const withAuthRetry = async <T>(makeRequest: () => Promise<T>, what: string, authMethods: Array<{ id: string }>): Promise<T> => {
      try {
        return await raceStartup(makeRequest());
      } catch (err) {
        if (authMethods.length === 0 || !isAuthError(err)) return withExit(Promise.reject<T>(err), what);
        const methodId = this.driver.authMethodId ?? authMethods[0]!.id;
        await withExit(raceStartup(conn.request("authenticate", { methodId })), "authenticate");
        return withExit(raceStartup(makeRequest()), what);
      }
    };

    try {
      const init = (await raceStartup(withExit(
        conn.request("initialize", {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "tiny", title: "tiny", version: TINY_VERSION },
        }),
        "initialize",
      ))) as { agentCapabilities?: AcpCaps; authMethods?: Array<{ id: string }> };
      const caps: AcpCaps = init?.agentCapabilities ?? {};
      const authMethods = Array.isArray(init?.authMethods) ? init.authMethods : [];

      // agentCapabilities is known right after initialize, so throw here, before turn_started
      // (to keep the invariant of never throwing after turn_started)
      if (p.images && p.images.length > 0 && !caps.promptCapabilities?.image) {
        throw new Error(`${label} does not accept image prompts`);
      }

      const mcpServers = p.mcpServer
        ? [
            {
              name: "tiny",
              command: p.mcpServer.command,
              args: p.mcpServer.args,
              env: Object.entries(p.mcpServer.env).map(([name, value]) => ({ name, value })),
            },
          ]
        : [];

      let configOptions: Array<{ id: string; category?: string | null }> = [];
      if (p.agentSessionId) {
        const params = { sessionId: p.agentSessionId, cwd: p.cwd, mcpServers };
        let r: { configOptions?: unknown } | null;
        if (caps.sessionCapabilities?.resume !== undefined && caps.sessionCapabilities?.resume !== null) {
          r = (await withAuthRetry(() => conn.request("session/resume", params), "session/resume", authMethods)) as typeof r;
        } else if (caps.loadSession) {
          replaying = true;
          try {
            r = (await withAuthRetry(() => conn.request("session/load", params), "session/load", authMethods)) as typeof r;
          } finally {
            replaying = false;
          }
        } else {
          throw new Error(`${label} cannot resume sessions (no session/resume or session/load capability)`);
        }
        sessionId = p.agentSessionId;
        if (Array.isArray(r?.configOptions)) configOptions = r.configOptions as typeof configOptions;
      } else {
        const r = (await withAuthRetry(() => conn.request("session/new", { cwd: p.cwd, mcpServers }), "session/new", authMethods)) as {
          sessionId: string;
          configOptions?: unknown;
        };
        sessionId = r.sessionId;
        if (Array.isArray(r.configOptions)) configOptions = r.configOptions as typeof configOptions;
      }
      p.emit({ type: "turn_started", payload: { agentSessionId: sessionId } });

      // Never throw after emitting turn_started (invariant that lets SessionManager save the
      // agentSessionId). From here on, catch failures, turn them into turn_failed, and return with agentSessionId
      try {
        // model / effort go through ACP configOptions (looked up by category). Do nothing if the agent does not expose them
        for (const [category, value] of [
          ["model", p.model],
          ["thought_level", p.effort],
        ] as const) {
          if (!value) continue;
          const opt = configOptions.find((o) => o.category === category);
          if (!opt) continue;
          await withExit(conn.request("session/set_config_option", { sessionId, configId: opt.id, value }), "session/set_config_option");
        }

        const prompt = [
          ...(p.images ?? []).map((img) => ({ type: "image", data: img.data, mimeType: img.mediaType })),
          { type: "text", text: p.prompt },
        ];

        // If prompt does not return within cancelTimeoutMs after the interrupt, give up and kill the process.
        // Uses onAborted, so it still fires immediately even if the abort happened before this registration
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const killOnStall = new Promise<never>((_, reject) => {
          onAborted(() => {
            killTimer = setTimeout(() => reject(new Error(`${label} did not stop within ${cancelTimeoutMs}ms after cancel`)), cancelTimeoutMs);
            killTimer.unref?.();
          });
        });
        let res: { stopReason?: string };
        try {
          res = (await Promise.race([withExit(conn.request("session/prompt", { sessionId, prompt }), "session/prompt"), killOnStall])) as {
            stopReason?: string;
          };
        } finally {
          if (killTimer) clearTimeout(killTimer);
        }

        flushThought();
        flushText();
        const resultText = texts.length > 0 ? texts.join("\n") : null;
        const stop = res?.stopReason ?? "end_turn";
        if (stop === "cancelled") {
          for (const id of started.keys()) finish(id, true); // synthesize unfinished tools (turn_failed, so isError)
          p.emit({ type: "turn_failed", payload: { error: "interrupted" } });
        } else if (stop === "end_turn" || stop === "max_tokens" || stop === "max_turn_requests") {
          for (const id of started.keys()) finish(id, false); // synthesize unfinished tools (turn_completed, so treated as success)
          p.emit({ type: "turn_completed", payload: { costUsd, resultText, contextTokens } });
        } else {
          for (const id of started.keys()) finish(id, true); // synthesize unfinished tools (turn_failed, so isError)
          p.emit({ type: "turn_failed", payload: { error: `stopReason: ${stop}` } });
        }
        return { agentSessionId: sessionId, costUsd, resultText };
      } catch (err) {
        flushThought();
        flushText();
        for (const id of started.keys()) finish(id, true); // synthesize unfinished tools (turn_failed, so isError)
        const resultText = texts.length > 0 ? texts.join("\n") : null;
        const msg = err instanceof Error ? err.message : String(err);
        // Failures during abort (interrupted set_config_option, the stall timer, etc.) are all reported as interrupted.
        // Keep the raw reason on stderr so a stall stays visible in the logs
        if (aborted) console.error(msg);
        p.emit({ type: "turn_failed", payload: { error: aborted ? "interrupted" : msg } });
        return { agentSessionId: sessionId, costUsd, resultText };
      }
    } finally {
      // Even on the exception path (throw), honor the contract: every tool_started gets a tool_finished.
      // finish() is guarded by the finished set, so overlapping with the success path is safe (idempotent)
      for (const id of started.keys()) finish(id, false);
      p.signal.removeEventListener("abort", onAbort);
      conn.close();
      proc.kill();
    }
  }
}
