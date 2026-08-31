import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";
import type { AgentAdapter, RunTurnParams, TurnResult } from "./adapter.js";
import { writeTinyMcpServer } from "./agents/codex.js";
import { agentEnv, type AgentDriver, type AgentLaunch } from "./agents/index.js";
import { JsonRpcConnection } from "./jsonrpc-stdio.js";
import type { PermissionDecision } from "./permission-broker.js";
import { oneLine, type ToolHint, type ToolKind } from "./tool-kinds.js";
import { TINY_VERSION } from "./version.js";

// Native Codex adapter (JSON-RPC/stdio against `codex app-server`).
// The source of truth for the mapping is the HANDOFF section "Codex app-server measurements" (codex-cli 0.149.1).
// Same structure as AcpAdapter: spawn a process per turn, thread/resume from the 2nd turn on.
// Once turn_started is emitted, never throw again (so SessionManager can save agentSessionId).

export interface CodexProcess {
  conn: JsonRpcConnection;
  kill(): void;
  /** Tail of stderr to append to error messages */
  stderrTail(): string;
}

export type CodexSpawn = (launch: AgentLaunch, opts: { cwd: string; env: Record<string, string | undefined> }) => CodexProcess;

/** The real one: spawns `codex app-server` and speaks JSON-RPC over stdin/stdout */
export const spawnCodexProcess: CodexSpawn = (launch, opts) => {
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

interface Preset {
  approvalPolicy: "on-request";
  sandbox: "workspace-write" | "danger-full-access";
  sandboxPolicy: { type: "workspaceWrite" | "dangerFullAccess" };
}

// tiny permission mode → Codex approval/sandbox settings.
// Measured: even with on-request, safe commands inside the sandbox are auto-approved and no
// requestApproval arrives (the adapter is written to answer if one comes; none coming is also normal).
// auto / bypass keep approvalPolicy at on-request too: with `never`, codex fails MCP tool calls as
// "approval required but policy is never" without ever sending an approval request (measured:
// send_user_file ends as tool_finished isError). The adapter accepts approval requests without
// asking (askApproval), so the outcome is the same
const PRESETS: Record<string, Preset> = {
  ask: { approvalPolicy: "on-request", sandbox: "workspace-write", sandboxPolicy: { type: "workspaceWrite" } },
  auto: { approvalPolicy: "on-request", sandbox: "workspace-write", sandboxPolicy: { type: "workspaceWrite" } },
  bypass: { approvalPolicy: "on-request", sandbox: "danger-full-access", sandboxPolicy: { type: "dangerFullAccess" } },
};

/** Strips the `/bin/zsh -lc '…'` wrapper to get the actual command (returned as-is if it does not match) */
export function unwrapShell(command: string): string {
  const m = /^\/bin\/\w+ -lc ['"]([\s\S]*)['"]$/.exec(command);
  return m ? m[1]! : command;
}

interface CodexItem {
  id?: string;
  type?: string;
  status?: string;
  error?: unknown;
  command?: string;
  cwd?: string;
  changes?: Array<{ path?: string }>;
  server?: string;
  /** agentMessage: "commentary" = progress note between tool work, "final_answer" = the reply (measured 0.149.x) */
  phase?: unknown;
  /** reasoning: entries are strings or { text } objects; measured turns often carry none */
  summary?: unknown;
  content?: unknown;
  tool?: string;
  arguments?: unknown;
  query?: string;
  text?: string;
}

interface ToolInfo {
  toolName: string;
  kind: ToolKind;
  input: Record<string, unknown>;
  summary: string;
}

/** item → tiny's tool_started equivalent (null for items that are not tools) */
export function describeCodexItem(item: CodexItem): ToolInfo | null {
  switch (item.type) {
    case "commandExecution": {
      const command = typeof item.command === "string" ? item.command : "";
      return {
        toolName: "commandExecution",
        kind: "execute",
        input: { command, cwd: item.cwd },
        summary: oneLine(unwrapShell(command) || "commandExecution"),
      };
    }
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const first = typeof changes[0]?.path === "string" ? path.basename(changes[0]!.path!) : "files";
      const more = changes.length > 1 ? ` +${changes.length - 1} files` : "";
      return { toolName: "fileChange", kind: "edit", input: { changes }, summary: oneLine(first + more) };
    }
    case "mcpToolCall": {
      const toolName = `${item.server ?? "mcp"}_${item.tool ?? "tool"}`;
      const args = (item.arguments && typeof item.arguments === "object" ? item.arguments : {}) as Record<string, unknown>;
      const file = typeof args.path === "string" ? path.basename(args.path) : null;
      const summary = item.tool === "send_user_file" ? `Sent: ${file ?? "a file"}` : toolName;
      return { toolName, kind: "other", input: args, summary: oneLine(summary) };
    }
    case "webSearch": {
      const query = typeof item.query === "string" ? item.query : "";
      return { toolName: "webSearch", kind: "fetch", input: { query }, summary: oneLine(query || "webSearch") };
    }
    default:
      return null; // userMessage / reasoning / plan / agentMessage …
  }
}

interface CodexQuestion {
  id?: string;
  header?: string;
  question?: string;
  options?: Array<{ label?: string; description?: string }> | null;
  isOther?: boolean;
}

/** The text a reasoning item carries. Entries are strings or { text } objects; measured turns often carry none */
function reasoningText(item: CodexItem): string {
  const parts: string[] = [];
  for (const list of [item.summary, item.content]) {
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      if (typeof e === "string") parts.push(e);
      else if (e && typeof e === "object" && typeof (e as { text?: unknown }).text === "string") {
        parts.push((e as { text: string }).text);
      }
    }
  }
  return parts.join("\n").trim();
}

export class CodexAdapter implements AgentAdapter {
  private spawn: CodexSpawn;
  private cancelTimeoutMs: number;
  // Serialization queue per profileDir. config.toml is a per-CODEX_HOME (= profileDir) file and
  // the only channel for passing MCP (send_user_file) into a turn, so no other turn may rewrite it
  // between "write config.toml" and "that codex finishes reading it".
  // Lock span = writeTinyMcpServer → spawn → initialize → thread/start|resume →
  //   until codex finishes starting tiny's MCP (mcpServer/startupStatus/updated with
  //   name === "tiny" and status !== "starting").
  //   Capped at mcpLockTimeoutMs (default 10s); turns without MCP release on the thread response,
  //   and if the turn ends first it releases there (every path is idempotent).
  // The lock used to be held for the whole turn, but the token in config.toml is now turn-scoped
  // (expires when the turn ends), so our env lingering into another turn's span is harmless. Hence
  // multiple sessions on the same Codex profile can run turns concurrently once MCP has started.
  private locks = new Map<string, Promise<void>>();
  // Active turn count per profileDir. The tiny region in config.toml may be cleared only when
  // this reaches 0 (= no turns are running on that profile).
  // Clearing the region of a running turn would break that turn's MCP startup.
  private active = new Map<string, number>();
  private mcpLockTimeoutMs: number;

  constructor(
    private driver: AgentDriver,
    opts: { spawn?: CodexSpawn; cancelTimeoutMs?: number; mcpLockTimeoutMs?: number } = {},
  ) {
    this.spawn = opts.spawn ?? spawnCodexProcess;
    this.cancelTimeoutMs = opts.cancelTimeoutMs ?? 5000;
    this.mcpLockTimeoutMs = opts.mcpLockTimeoutMs ?? 10000;
  }

  /** Waits in profileDir's serialization queue; returns a release function when our turn comes */
  private async acquireProfileLock(profileDir: string): Promise<() => void> {
    const prev = this.locks.get(profileDir) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => (release = resolve));
    this.locks.set(
      profileDir,
      prev.then(() => next),
    );
    await prev;
    return release;
  }

  async runTurn(p: RunTurnParams): Promise<TurnResult> {
    // Reject an abort that happens before turn_started (before spawning the process) here
    if (p.signal.aborted) throw new Error(`${this.driver.label} turn was interrupted before it started`);
    const label = this.driver.label;
    const preset = PRESETS[p.permissionMode] ?? PRESETS.ask!;
    const cancelTimeoutMs = this.cancelTimeoutMs;

    // Turns waiting for the lock also count as active (so that when a preceding turn ends, it does
    // not mistake this for "the last turn ended" and clear the region a waiting turn is about to write)
    this.active.set(p.profileDir, (this.active.get(p.profileDir) ?? 0) + 1);
    let releaseLock: () => void;
    try {
      releaseLock = await this.acquireProfileLock(p.profileDir);
    } catch (err) {
      this.leaveProfile(p.profileDir, label);
      throw err;
    }
    let lockReleased = false;
    const releaseLockOnce = () => {
      if (lockReleased) return;
      lockReleased = true;
      releaseLock();
    };

    try {
      // If aborted while waiting for the lock, throw here without spawning even when our turn comes
      // (before turn_started, so no events are emitted at all)
      if (p.signal.aborted) throw new Error(`${label} turn was interrupted before it started`);
      return await this.runTurnLocked(p, label, preset, cancelTimeoutMs, releaseLockOnce);
    } finally {
      // When the turn ends (via success, turn_failed, or an exception), clear the tiny region in
      // config.toml only if this was the last turn running on the profile. Forgetting to clear it
      // would hand a later manual `codex resume` / `CODEX_HOME=… codex` an MCP config with the old
      // session's TINY_SESSION_ID still in it (the token itself already expired at turn end).
      this.leaveProfile(p.profileDir, label);
      // Whichever path exits above (including synchronous throws from writeTinyMcpServer / spawn), always return the lock
      releaseLockOnce();
    }
  }

  /** Decrements the active turn count; at 0, clears the tiny region in config.toml (best effort) */
  private leaveProfile(profileDir: string, label: string): void {
    const left = (this.active.get(profileDir) ?? 1) - 1;
    if (left > 0) {
      this.active.set(profileDir, left);
      return;
    }
    this.active.delete(profileDir);
    try {
      writeTinyMcpServer(profileDir, null);
    } catch (err) {
      console.error(`${label}: failed to clear config.toml mcp region for ${profileDir}:`, err);
    }
  }

  private async runTurnLocked(
    p: RunTurnParams,
    label: string,
    preset: Preset,
    cancelTimeoutMs: number,
    releaseLock: () => void,
  ): Promise<TurnResult> {
    // MCP (send_user_file) cannot be passed per thread (measured). Rewrite config.toml before spawning each turn
    writeTinyMcpServer(p.profileDir, p.mcpServer);

    const launch = this.driver.launch ?? { command: this.driver.bin, args: ["app-server"] };
    const proc = this.spawn(launch, { cwd: p.cwd, env: agentEnv(this.driver, p.profileDir) });
    const conn = proc.conn;

    // --- per-turn state ---
    let threadId: string | null = null;
    let turnId: string | null = null;
    let interruptSent = false;
    const texts: string[] = [];
    const started = new Map<string, ToolInfo>();
    const finished = new Set<string>();
    let contextTokens: number | null = null;
    let terminalEmitted = false; // true once turn_completed / turn_failed was emitted (stops the synthesis in finally)
    let aborted = false;
    const abortWaiters: Array<() => void> = [];
    const onAborted = (fn: () => void) => {
      if (aborted) fn();
      else abortWaiters.push(fn);
    };

    const finish = (id: string, isError: boolean) => {
      if (finished.has(id)) return;
      finished.add(id);
      p.emit({ type: "tool_finished", payload: { toolUseId: id, isError } });
    };
    const startTool = (id: string, info: ToolInfo) => {
      started.set(id, info);
      p.emit({
        type: "tool_started",
        payload: { toolUseId: id, toolName: info.toolName, input: info.input, kind: info.kind, summary: info.summary },
      });
    };

    // turn/completed can arrive before the turn/start response, so set up the listener first
    let resolveTurn: ((turn: Record<string, unknown>) => void) | null = null;
    const turnDone = new Promise<Record<string, unknown>>((resolve) => (resolveTurn = resolve));

    conn.onNotification("item/started", (params) => {
      const item = (params as { item?: CodexItem })?.item;
      if (!item?.id) return;
      const info = describeCodexItem(item);
      if (info && !started.has(item.id)) startTool(item.id, info);
    });
    conn.onNotification("item/completed", (params) => {
      const item = (params as { item?: CodexItem })?.item;
      if (!item?.id) return;
      if (item.type === "agentMessage") {
        if (typeof item.text === "string" && item.text !== "") {
          // "commentary" is the model narrating its progress before/between tool work (measured:
          // "I'm applying the required skill, then…"). Shown like Claude's thinking line and kept
          // out of resultText — the push and the Done line only carry the actual reply
          if (item.phase === "commentary") {
            p.emit({ type: "assistant_thinking", payload: { text: item.text } });
          } else {
            texts.push(item.text);
            p.emit({ type: "assistant_text", payload: { text: item.text } });
          }
        }
        return;
      }
      if (item.type === "reasoning") {
        // Measured empty (summary: [], content: []) on current defaults, but a populated summary
        // is the same narration; show whatever text it carries
        const text = reasoningText(item);
        if (text !== "") p.emit({ type: "assistant_thinking", payload: { text } });
        return;
      }
      const info = describeCodexItem(item);
      if (!info) return;
      if (!started.has(item.id)) startTool(item.id, info); // safeguard for paths that skip item/started
      finish(item.id, item.status === "failed" || item.status === "declined" || !!item.error);
    });
    conn.onNotification("thread/tokenUsage/updated", (params) => {
      const usage = (params as { tokenUsage?: { last?: Record<string, unknown>; total?: Record<string, unknown> } })?.tokenUsage;
      const last = usage?.last;
      if (last) {
        const n = (k: string) => (typeof last[k] === "number" ? (last[k] as number) : 0);
        contextTokens = n("inputTokens") + n("cachedInputTokens") + n("outputTokens");
      }
      // total is cumulative across the turn (measured 207 → 212); exactly what the Running row shows
      const out = usage?.total?.outputTokens;
      if (typeof out === "number" && Number.isFinite(out)) p.progress?.({ outputTokens: out });
    });
    conn.onNotification("turn/completed", (params) => {
      const n = params as { threadId?: string; turn?: Record<string, unknown> };
      if (threadId && typeof n?.threadId === "string" && n.threadId !== threadId) return;
      resolveTurn?.(n?.turn ?? {});
    });
    // Measured: codex starts the MCP servers from config.toml when the thread starts, and notifies
    // starting → ready per server (failed-equivalent + error / failureReason on failure).
    // Once tiny's entry leaves starting, config.toml has been fully read, so return the lock.
    let mcpLockTimer: ReturnType<typeof setTimeout> | undefined;
    const releaseMcpLock = () => {
      if (mcpLockTimer) {
        clearTimeout(mcpLockTimer);
        mcpLockTimer = undefined;
      }
      releaseLock(); // idempotent
    };
    conn.onNotification("mcpServer/startupStatus/updated", (params) => {
      const n = (params ?? {}) as { name?: unknown; status?: unknown };
      if (n.name === "tiny" && typeof n.status === "string" && n.status !== "starting") releaseMcpLock();
    });
    // thread/status/changed / turn/started / item/agentMessage/delta / thread/started /
    // remoteControl/status/changed / account/rateLimits/updated are dropped

    /** Asks the user (null if interrupted) */
    const ask = async (toolName: string, input: unknown, hint: ToolHint): Promise<PermissionDecision | null> => {
      const cancelled = new Promise<null>((resolve) => onAborted(() => resolve(null)));
      return await Promise.race([p.requestPermission(toolName, input, hint), cancelled]);
    };
    // Shortcut that unconditionally accepts only commandExecution / fileChange approval requests in auto / bypass.
    // item/tool/requestUserInput does not go through here (questions always go to the user even in
    // auto/bypass — answering them automatically would be pointless. ask() itself always calls requestPermission)
    const askApproval = async (toolName: string, input: unknown, hint: ToolHint): Promise<PermissionDecision | null> => {
      if (p.permissionMode === "auto" || p.permissionMode === "bypass") return { behavior: "allow" };
      return await ask(toolName, input, hint);
    };
    const decisionOf = (d: PermissionDecision | null) =>
      d === null ? { decision: "cancel" } : d.behavior === "allow" ? { decision: "accept" } : { decision: "decline" };

    conn.onRequest("item/commandExecution/requestApproval", async (params) => {
      const req = (params ?? {}) as { itemId?: string; command?: string; cwd?: string; reason?: string };
      const command = typeof req.command === "string" ? req.command : "";
      const hint: ToolHint = { kind: "execute", summary: oneLine(unwrapShell(command) || "commandExecution") };
      return decisionOf(await askApproval("commandExecution", { command: req.command, cwd: req.cwd, reason: req.reason }, hint));
    });

    conn.onRequest("item/fileChange/requestApproval", async (params) => {
      const req = (params ?? {}) as { itemId?: string; reason?: string };
      const summary = (req.itemId ? started.get(req.itemId)?.summary : null) ?? "Apply file changes";
      const hint: ToolHint = { kind: "edit", summary };
      return decisionOf(await askApproval("fileChange", { itemId: req.itemId, reason: req.reason }, hint));
    });

    // Measured: with approvalPolicy on-request, MCP tool calls (send_user_file included) also get a
    // `mcpServer/elicitation/request` (a separate path from item/commandExecution|fileChange/requestApproval).
    // The `tiny` server that tiny itself registered is fully trusted (protected by tinyd's own Bearer auth),
    // so always accept without asking (same treatment as the Claude adapter unconditionally allowing it via allowedTools).
    // Any other server (ones the user added to config.toml themselves) is treated like commandExecution.
    conn.onRequest("mcpServer/elicitation/request", async (params) => {
      const req = (params ?? {}) as { serverName?: string; message?: string };
      if (req.serverName === "tiny") return { action: "accept", content: {} };
      const hint: ToolHint = { kind: "other", summary: oneLine(req.message ?? `MCP: ${req.serverName ?? "tool"}`) };
      const d = await askApproval("mcpElicitation", { serverName: req.serverName, message: req.message }, hint);
      return d !== null && d.behavior === "allow" ? { action: "accept", content: {} } : { action: "decline" };
    });

    // Measured: never arrives in 0.149.1's Default mode (request_user_input is unusable).
    // Provide just the schema-faithful mapping (if it ever comes, the iOS question banner can render it as is)
    conn.onRequest("item/tool/requestUserInput", async (params) => {
      const qs = (Array.isArray((params as { questions?: CodexQuestion[] })?.questions)
        ? (params as { questions: CodexQuestion[] }).questions
        : []) as CodexQuestion[];
      const input = {
        questions: qs.map((q) => ({
          question: q.question,
          header: q.header,
          options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description })),
          multiSelect: false,
        })),
      };
      const hint: ToolHint = { kind: "question", summary: oneLine(qs[0]?.question ?? "Question") };
      const d = await ask("AskUserQuestion", input, hint);
      if (!d || d.behavior !== "allow") return { answers: {} };
      const answers = (d.updatedInput?.answers ?? {}) as Record<string, unknown>;
      const out: Record<string, { answers: string[] }> = {};
      for (const q of qs) {
        const a = q.question ? answers[q.question] : undefined;
        if (typeof a === "string" && q.id) out[q.id] = { answers: [a] };
      }
      return { answers: out };
    });

    const withExit = async <T>(work: Promise<T>, what: string): Promise<T> => {
      try {
        return await work;
      } catch (err) {
        const tail = proc.stderrTail();
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`${label} ${what} failed: ${msg}${tail ? `\n${tail}` : ""}`);
      }
    };

    const sendInterrupt = () => {
      if (interruptSent || !threadId || !turnId) return;
      interruptSent = true;
      void conn.request("turn/interrupt", { threadId, turnId }).catch(() => {});
    };
    const onAbort = () => {
      aborted = true;
      for (const w of abortWaiters.splice(0)) w();
      sendInterrupt(); // if turnId is not known yet, sent after the turn/start response
    };
    p.signal.addEventListener("abort", onAbort);

    // An abort during startup (initialize through thread/start) is before turn_started, so bail out with a throw
    let rejectStartupAbort: (() => void) | null = null;
    const abortedDuringStartup = new Promise<never>((_, reject) => {
      rejectStartupAbort = () => reject(new Error(`${label} interrupted before the turn started`));
    });
    abortedDuringStartup.catch(() => {});
    onAborted(() => rejectStartupAbort!());
    const raceStartup = <T>(work: Promise<T>): Promise<T> => Promise.race([work, abortedDuringStartup]);

    try {
      await raceStartup(
        withExit(conn.request("initialize", { clientInfo: { name: "tiny", title: "tiny", version: TINY_VERSION } }), "initialize"),
      );
      // Measured to work without this, but send it in case future versions change (harmless)
      conn.notify("initialized", {});

      if (p.agentSessionId) {
        // The response carries the whole past-turn history, but tiny's DB is the source of truth, so drop it
        await raceStartup(
          withExit(
            conn.request("thread/resume", {
              threadId: p.agentSessionId,
              cwd: p.cwd,
              approvalPolicy: preset.approvalPolicy,
              sandbox: preset.sandbox,
            }),
            "thread/resume",
          ),
        );
        threadId = p.agentSessionId;
      } else {
        const r = (await raceStartup(
          withExit(
            conn.request("thread/start", {
              cwd: p.cwd,
              approvalPolicy: preset.approvalPolicy,
              sandbox: preset.sandbox,
              ...(p.model ? { model: p.model } : {}),
            }),
            "thread/start",
          ),
        )) as { thread?: { id?: unknown } };
        const id = r?.thread?.id;
        if (typeof id !== "string" || id === "") throw new Error(`${label} thread/start did not return a thread id`);
        threadId = id;
      }
      // A turn without MCP has no need for codex to read config.toml, so return the lock here.
      // A turn with MCP waits for startupStatus, capped so a codex/environment that never notifies cannot wedge us.
      if (!p.mcpServer) {
        releaseMcpLock();
      } else {
        mcpLockTimer = setTimeout(releaseMcpLock, this.mcpLockTimeoutMs);
        mcpLockTimer.unref?.();
      }

      p.emit({ type: "turn_started", payload: { agentSessionId: threadId } });

      // From here on, never throw (failures become turn_failed + a return carrying agentSessionId)
      try {
        // Give up if turn/completed does not arrive within cancelTimeoutMs after the interrupt
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const killOnStall = new Promise<never>((_, reject) => {
          onAborted(() => {
            killTimer = setTimeout(() => reject(new Error(`${label} did not stop within ${cancelTimeoutMs}ms after interrupt`)), cancelTimeoutMs);
            killTimer.unref?.();
          });
        });

        // If codex dies without emitting turn/completed (crash, SIGKILL, etc.), turnDone stays
        // waiting for a notification and nothing settles it. Detect the closed connection via
        // conn.onClose and mix it into the same race as turnDone / killOnStall so it always terminates.
        const diedBeforeCompletion = new Promise<never>((_, reject) => {
          conn.onClose(() => {
            const tail = proc.stderrTail();
            reject(new Error(`${label} exited before the turn completed${tail ? `\n${tail}` : ""}`));
          });
        });
        diedBeforeCompletion.catch(() => {}); // prevent an unhandled rejection when unused

        let turn: Record<string, unknown>;
        try {
          const input = [
            ...(p.images ?? []).map((img) => ({ type: "image", url: `data:${img.mediaType};base64,${img.data}` })),
            { type: "text", text: p.prompt },
          ];
          const res = (await Promise.race([
            withExit(
              conn.request("turn/start", {
                threadId,
                input,
                cwd: p.cwd,
                approvalPolicy: preset.approvalPolicy,
                sandboxPolicy: preset.sandboxPolicy,
                ...(p.model ? { model: p.model } : {}),
                ...(p.effort ? { effort: p.effort } : {}),
              }),
              "turn/start",
            ),
            killOnStall,
            diedBeforeCompletion,
          ])) as { turn?: { id?: unknown } };
          const id = res?.turn?.id;
          turnId = typeof id === "string" ? id : null;
          if (aborted) sendInterrupt(); // send as soon as turnId is known
          turn = await Promise.race([turnDone, killOnStall, diedBeforeCompletion]);
        } finally {
          if (killTimer) clearTimeout(killTimer);
        }

        const resultText = texts.length > 0 ? texts.join("\n") : null;
        const status = turn?.status;
        const fail = (error: string) => {
          for (const id of started.keys()) finish(id, true);
          terminalEmitted = true;
          p.emit({ type: "turn_failed", payload: { error } });
        };
        if (status === "completed") {
          for (const id of started.keys()) finish(id, false);
          terminalEmitted = true;
          p.emit({ type: "turn_completed", payload: { costUsd: null, resultText, contextTokens } });
        } else if (status === "interrupted") {
          fail("interrupted");
        } else if (status === "failed") {
          const message = (turn?.error as { message?: unknown } | undefined)?.message;
          fail(typeof message === "string" && message !== "" ? message : "turn failed");
        } else {
          fail(`turn status: ${String(status)}`);
        }
        return { agentSessionId: threadId, costUsd: null, resultText };
      } catch (err) {
        for (const id of started.keys()) finish(id, true);
        const resultText = texts.length > 0 ? texts.join("\n") : null;
        const msg = err instanceof Error ? err.message : String(err);
        if (aborted) console.error(msg); // still log the reason for the stall
        terminalEmitted = true;
        p.emit({ type: "turn_failed", payload: { error: aborted ? "interrupted" : msg } });
        return { agentSessionId: threadId, costUsd: null, resultText };
      }
    } finally {
      // Synthesizing tool_finished after turn_completed / turn_failed was already emitted breaks the
      // contract (nothing after a terminal event). Today every path synthesizes above, so started is
      // empty by the time we get here, but guard against future missed branches (do nothing if terminalEmitted)
      if (!terminalEmitted) for (const id of started.keys()) finish(id, false);
      // Clean up the lock and timer even on paths where the turn ended without waiting for startupStatus (failure, interrupt, process death)
      releaseMcpLock();
      p.signal.removeEventListener("abort", onAbort);
      conn.close();
      proc.kill();
    }
  }
}
