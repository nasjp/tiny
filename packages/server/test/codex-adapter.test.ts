import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RunTurnParams, TurnEventInput } from "../src/adapter.js";
import { getDriver } from "../src/agents/index.js";
import { CodexAdapter } from "../src/codex-adapter.js";
import { assertTurnEventInvariants } from "./adapter-contract.js";
import { fakeCodexServer, type FakeCodexCtx } from "./fake-codex-server.js";

const driver = getDriver("codex");

function baseParams(over: Partial<RunTurnParams> = {}): { p: RunTurnParams; events: TurnEventInput[] } {
  const events: TurnEventInput[] = [];
  const p: RunTurnParams = {
    agentSessionId: null,
    profileDir: "/tmp/profiles/cx",
    cwd: "/tmp/repo",
    permissionMode: "ask",
    model: null,
    effort: null,
    prompt: "hello",
    emit: (ev) => events.push(ev),
    requestPermission: async () => ({ behavior: "allow" }),
    mcpServer: null, // don't write config.toml (the writing path has dedicated tests)
    signal: new AbortController().signal,
    ...over,
  };
  return { p, events };
}

const item = (ctx: FakeCodexCtx, method: "item/started" | "item/completed", it: Record<string, unknown>) =>
  ctx.notify(method, { threadId: ctx.threadId, turnId: ctx.turnId, item: it });

const COMPLETED = { id: "turn_1", status: "completed", items: [], error: null };

/** Replays one measured turn (command execution → reply) */
async function echoTurn(ctx: FakeCodexCtx) {
  ctx.notify("thread/status/changed", { status: "running" });
  ctx.notify("turn/started", { threadId: ctx.threadId, turn: { id: ctx.turnId } });
  item(ctx, "item/started", { type: "userMessage", id: "usr_1", text: "hello" });
  item(ctx, "item/completed", { type: "userMessage", id: "usr_1", text: "hello" });
  item(ctx, "item/started", { type: "reasoning", id: "rsn_1" });
  item(ctx, "item/completed", { type: "reasoning", id: "rsn_1" });
  item(ctx, "item/started", { type: "commandExecution", id: "exec-1", status: "inProgress", command: "/bin/zsh -lc 'echo hi'", cwd: "/tmp/repo" });
  item(ctx, "item/completed", { type: "commandExecution", id: "exec-1", status: "completed", command: "/bin/zsh -lc 'echo hi'", cwd: "/tmp/repo", exitCode: 0 });
  item(ctx, "item/started", { type: "agentMessage", id: "msg_1", text: "" });
  ctx.notify("item/agentMessage/delta", { delta: "do" });
  item(ctx, "item/completed", { type: "agentMessage", id: "msg_1", text: "done" });
  ctx.notify("thread/tokenUsage/updated", {
    threadId: ctx.threadId,
    tokenUsage: {
      total: { totalTokens: 20000, inputTokens: 12000, cachedInputTokens: 6000, outputTokens: 2000 },
      last: { totalTokens: 5100, inputTokens: 4000, cachedInputTokens: 1000, outputTokens: 100 },
      modelContextWindow: 400000,
    },
  });
  ctx.notify("account/rateLimits/updated", {});
  return COMPLETED;
}

describe("CodexAdapter", () => {
  it("runs initialize → initialized → thread/start → turn/start and maps notifications to events", async () => {
    const fake = fakeCodexServer({ onTurn: echoTurn });
    const { p, events } = baseParams();
    const result = await new CodexAdapter(driver, { spawn: fake.spawn }).runTurn(p);

    expect(result).toEqual({ agentSessionId: "thr_fake1", costUsd: null, resultText: "done" });
    expect(events.map((e) => e.type)).toEqual(["turn_started", "tool_started", "tool_finished", "assistant_text", "turn_completed"]);
    expect(events[0]!.payload).toEqual({ agentSessionId: "thr_fake1" });
    expect(events[1]!.payload).toEqual({
      toolUseId: "exec-1",
      toolName: "commandExecution",
      input: { command: "/bin/zsh -lc 'echo hi'", cwd: "/tmp/repo" },
      kind: "execute",
      summary: "echo hi", // strips the /bin/zsh -lc '…' wrapper
    });
    expect(events[2]!.payload).toEqual({ toolUseId: "exec-1", isError: false });
    expect(events[3]!.payload).toEqual({ text: "done" });
    // contextTokens = last's inputTokens + cachedInputTokens + outputTokens
    expect(events[4]!.payload).toEqual({ costUsd: null, resultText: "done", contextTokens: 5100 });
    assertTurnEventInvariants(events);

    const methods = fake.received.map((r) => r.method);
    expect(methods).toEqual(["initialize", "initialized", "thread/start", "turn/start"]);
    expect(fake.received[0]!.params.clientInfo).toMatchObject({ name: "tiny", title: "tiny" });
    expect(fake.received[3]!.params).toMatchObject({
      threadId: "thr_fake1",
      cwd: "/tmp/repo",
      input: [{ type: "text", text: "hello" }],
    });
    expect(fake.killed).toBe(1);
  });

  it("marks tool_finished isError when commandExecution is failed / declined", async () => {
    for (const status of ["failed", "declined"]) {
      const fake = fakeCodexServer({
        onTurn: async (ctx) => {
          item(ctx, "item/started", { type: "commandExecution", id: "exec-1", status: "inProgress", command: "rm -rf /", cwd: "/tmp/repo" });
          item(ctx, "item/completed", { type: "commandExecution", id: "exec-1", status, command: "rm -rf /", cwd: "/tmp/repo" });
          return COMPLETED;
        },
      });
      const { p, events } = baseParams();
      await new CodexAdapter(driver, { spawn: fake.spawn }).runTurn(p);
      expect(events.find((e) => e.type === "tool_started")!.payload).toMatchObject({ summary: "rm -rf /", kind: "execute" });
      expect(events.find((e) => e.type === "tool_finished")!.payload).toEqual({ toolUseId: "exec-1", isError: true });
      assertTurnEventInvariants(events);
    }
  });

  it("maps fileChange to kind edit with a basename summary (+N files when multiple)", async () => {
    const changes = [{ path: "/tmp/repo/src/a.ts", kind: { type: "update" } }, { path: "/tmp/repo/b.ts", kind: { type: "add" } }, { path: "/tmp/repo/c.ts", kind: { type: "add" } }];
    const fake = fakeCodexServer({
      onTurn: async (ctx) => {
        item(ctx, "item/started", { type: "fileChange", id: "fc-1", status: "inProgress", changes });
        item(ctx, "item/completed", { type: "fileChange", id: "fc-1", status: "completed", changes });
        return COMPLETED;
      },
    });
    const { p, events } = baseParams();
    await new CodexAdapter(driver, { spawn: fake.spawn }).runTurn(p);
    expect(events[1]!.payload).toEqual({ toolUseId: "fc-1", toolName: "fileChange", input: { changes }, kind: "edit", summary: "a.ts +2 files" });
    assertTurnEventInvariants(events);
  });

  it("maps mcpToolCall to kind other (send_user_file gets Sent: …) and webSearch to kind fetch", async () => {
    const args = { path: "/tmp/repo/out/report.html", caption: "take a look" };
    const fake = fakeCodexServer({
      onTurn: async (ctx) => {
        item(ctx, "item/started", { type: "mcpToolCall", id: "mcp-1", status: "inProgress", server: "tiny", tool: "send_user_file", arguments: args });
        item(ctx, "item/completed", { type: "mcpToolCall", id: "mcp-1", status: "completed", server: "tiny", tool: "send_user_file", arguments: args });
        item(ctx, "item/started", { type: "mcpToolCall", id: "mcp-2", status: "inProgress", server: "gh", tool: "list_prs", arguments: {} });
        item(ctx, "item/completed", { type: "mcpToolCall", id: "mcp-2", status: "failed", server: "gh", tool: "list_prs", arguments: {}, error: { message: "boom" } });
        item(ctx, "item/started", { type: "webSearch", id: "ws-1", status: "inProgress", query: "codex app-server" });
        item(ctx, "item/completed", { type: "webSearch", id: "ws-1", status: "completed", query: "codex app-server" });
        return COMPLETED;
      },
    });
    const { p, events } = baseParams();
    await new CodexAdapter(driver, { spawn: fake.spawn }).runTurn(p);
    const started = events.filter((e) => e.type === "tool_started").map((e) => e.payload);
    expect(started[0]).toEqual({ toolUseId: "mcp-1", toolName: "tiny_send_user_file", input: args, kind: "other", summary: "Sent: report.html" });
    expect(started[1]).toMatchObject({ toolUseId: "mcp-2", toolName: "gh_list_prs", kind: "other", summary: "gh_list_prs" });
    expect(started[2]).toEqual({ toolUseId: "ws-1", toolName: "webSearch", input: { query: "codex app-server" }, kind: "fetch", summary: "codex app-server" });
    expect(events.filter((e) => e.type === "tool_finished").map((e) => e.payload)).toEqual([
      { toolUseId: "mcp-1", isError: false },
      { toolUseId: "mcp-2", isError: true },
      { toolUseId: "ws-1", isError: false },
    ]);
    assertTurnEventInvariants(events);
  });

  it("synthesizes tool_started for a tool whose item/completed arrives without item/started", async () => {
    const fake = fakeCodexServer({
      onTurn: async (ctx) => {
        item(ctx, "item/completed", { type: "commandExecution", id: "exec-9", status: "completed", command: "ls", cwd: "/tmp/repo" });
        return COMPLETED;
      },
    });
    const { p, events } = baseParams();
    await new CodexAdapter(driver, { spawn: fake.spawn }).runTurn(p);
    expect(events.map((e) => e.type)).toEqual(["turn_started", "tool_started", "tool_finished", "turn_completed"]);
    assertTurnEventInvariants(events);
  });

  it("routes commandExecution approval to requestPermission in ask mode (allow → accept / deny → decline)", async () => {
    const decisions: unknown[] = [];
    const fake = fakeCodexServer({
      onTurn: async (ctx) => {
        item(ctx, "item/started", { type: "commandExecution", id: "exec-1", status: "inProgress", command: "/bin/bash -lc \"curl example.com\"", cwd: "/tmp/repo" });
        const req = { itemId: "exec-1", threadId: ctx.threadId, turnId: ctx.turnId, command: "/bin/bash -lc \"curl example.com\"", cwd: "/tmp/repo", reason: "network access" };
        decisions.push(await ctx.request("item/commandExecution/requestApproval", req));
        decisions.push(await ctx.request("item/commandExecution/requestApproval", req));
        item(ctx, "item/completed", { type: "commandExecution", id: "exec-1", status: "completed", command: "x", cwd: "/tmp/repo" });
        return COMPLETED;
      },
    });
    const asked: unknown[] = [];
    let n = 0;
    const { p, events } = baseParams({
      requestPermission: async (toolName, input, hint) => {
        asked.push([toolName, input, hint]);
        return n++ === 0 ? { behavior: "allow" } : { behavior: "deny", message: "no" };
      },
    });
    await new CodexAdapter(driver, { spawn: fake.spawn }).runTurn(p);
    expect(asked[0]).toEqual([
      "commandExecution",
      { command: "/bin/bash -lc \"curl example.com\"", cwd: "/tmp/repo", reason: "network access" },
      { kind: "execute", summary: "curl example.com" },
    ]);
    expect(decisions).toEqual([{ decision: "accept" }, { decision: "decline" }]);
    assertTurnEventInvariants(events);
  });

  it("accepts approval requests without asking in auto / bypass modes", async () => {
    for (const mode of ["auto", "bypass"]) {
      let decision: unknown;
      const fake = fakeCodexServer({
        onTurn: async (ctx) => {
          decision = await ctx.request("item/commandExecution/requestApproval", { itemId: "exec-1", command: "rm x", cwd: "/tmp/repo" });
          return COMPLETED;
        },
      });
      let called = false;
      const { p, events } = baseParams({
        permissionMode: mode,
        requestPermission: async () => {
          called = true;
          return { behavior: "allow" };
        },
      });
      await new CodexAdapter(driver, { spawn: fake.spawn }).runTurn(p);
      expect(called).toBe(false);
      expect(decision).toEqual({ decision: "accept" });
      assertTurnEventInvariants(events);
    }
  });

  it("gives fileChange approvals kind edit and the summary remembered from item/started (default wording when absent)", async () => {
    const asked: unknown[] = [];
    const decisions: unknown[] = [];
    const changes = [{ path: "/tmp/repo/x.ts", kind: { type: "update" } }];
    const fake = fakeCodexServer({
      onTurn: async (ctx) => {
        item(ctx, "item/started", { type: "fileChange", id: "fc-1", status: "inProgress", changes });
        decisions.push(await ctx.request("item/fileChange/requestApproval", { itemId: "fc-1", reason: "outside sandbox" }));
        decisions.push(await ctx.request("item/fileChange/requestApproval", { itemId: "fc-unknown", reason: "outside sandbox" }));
        item(ctx, "item/completed", { type: "fileChange", id: "fc-1", status: "completed", changes });
        return COMPLETED;
      },
    });
    const { p, events } = baseParams({
      requestPermission: async (toolName, input, hint) => {
        asked.push([toolName, input, hint]);
        return { behavior: "allow" };
      },
    });
    await new CodexAdapter(driver, { spawn: fake.spawn }).runTurn(p);
    expect(asked).toEqual([
      ["fileChange", { itemId: "fc-1", reason: "outside sandbox" }, { kind: "edit", summary: "x.ts" }],
      ["fileChange", { itemId: "fc-unknown", reason: "outside sandbox" }, { kind: "edit", summary: "Apply file changes" }],
    ]);
    expect(decisions).toEqual([{ decision: "accept" }, { decision: "accept" }]);
    assertTurnEventInvariants(events);
  });

  it("maps requestUserInput to AskUserQuestion and returns answers as questionId → answers[] (empty on deny)", async () => {
    const questions = [
      { id: "q1", header: "Color", question: "Which color do you prefer?", options: [{ label: "red", description: "warm" }, { label: "blue", description: "cool" }], isOther: false },
    ];
    const answers: unknown[] = [];
    const fake = fakeCodexServer({
      onTurn: async (ctx) => {
        answers.push(await ctx.request("item/tool/requestUserInput", { itemId: "tool-1", questions }));
        answers.push(await ctx.request("item/tool/requestUserInput", { itemId: "tool-2", questions }));
        return COMPLETED;
      },
    });
    const asked: unknown[] = [];
    let n = 0;
    const { p, events } = baseParams({
      requestPermission: async (toolName, input, hint) => {
        asked.push([toolName, input, hint]);
        return n++ === 0
          ? { behavior: "allow", updatedInput: { answers: { "Which color do you prefer?": "red" } } }
          : { behavior: "deny", message: "no" };
      },
    });
    await new CodexAdapter(driver, { spawn: fake.spawn }).runTurn(p);
    expect(asked[0]).toEqual([
      "AskUserQuestion",
      { questions: [{ question: "Which color do you prefer?", header: "Color", options: [{ label: "red", description: "warm" }, { label: "blue", description: "cool" }], multiSelect: false }] },
      { kind: "question", summary: "Which color do you prefer?" },
    ]);
    expect(answers).toEqual([{ answers: { q1: { answers: ["red"] } } }, { answers: {} }]);
    assertTurnEventInvariants(events);
  });

  it("still asks the user for requestUserInput in auto mode (only approvals get the auto short-circuit)", async () => {
    const questions = [
      { id: "q1", header: "Color", question: "Which color do you prefer?", options: [{ label: "red", description: "warm" }, { label: "blue", description: "cool" }], isOther: false },
    ];
    let answer: unknown;
    const fake = fakeCodexServer({
      onTurn: async (ctx) => {
        answer = await ctx.request("item/tool/requestUserInput", { itemId: "tool-1", questions });
        return COMPLETED;
      },
    });
    let called = false;
    const { p, events } = baseParams({
      permissionMode: "auto",
      requestPermission: async (toolName) => {
        called = true;
        expect(toolName).toBe("AskUserQuestion");
        return { behavior: "allow", updatedInput: { answers: { "Which color do you prefer?": "red" } } };
      },
    });
    await new CodexAdapter(driver, { spawn: fake.spawn }).runTurn(p);
    expect(called).toBe(true);
    expect(answer).toEqual({ answers: { q1: { answers: ["red"] } } });
    assertTurnEventInvariants(events);
  });

  it("accepts mcpServer/elicitation/request from tiny's own MCP server without asking (measured: on-request sends approvals even for send_user_file)", async () => {
    let result: unknown;
    const fake = fakeCodexServer({
      onTurn: async (ctx) => {
        result = await ctx.request("mcpServer/elicitation/request", {
          threadId: ctx.threadId,
          turnId: ctx.turnId,
          serverName: "tiny",
          mode: "form",
          message: 'Allow the tiny MCP server to run tool "send_user_file"?',
          requestedSchema: { type: "object", properties: {} },
        });
        return COMPLETED;
      },
    });
    let called = false;
    const { p, events } = baseParams({
      requestPermission: async () => {
        called = true;
        return { behavior: "allow" };
      },
    });
    await new CodexAdapter(driver, { spawn: fake.spawn }).runTurn(p);
    expect(called).toBe(false);
    expect(result).toEqual({ action: "accept", content: {} });
    assertTurnEventInvariants(events);
  });

  it("asks for mcpServer/elicitation/request from non-tiny MCP servers like commandExecution in ask mode, and not in auto/bypass", async () => {
    const asked: unknown[] = [];
    const results: unknown[] = [];
    const fake = fakeCodexServer({
      onTurn: async (ctx) => {
        results.push(
          await ctx.request("mcpServer/elicitation/request", {
            threadId: ctx.threadId,
            turnId: ctx.turnId,
            serverName: "other",
            message: 'Allow the "other" MCP server to run tool "x"?',
          }),
        );
        return COMPLETED;
      },
    });
    const { p, events } = baseParams({
      requestPermission: async (toolName, input, hint) => {
        asked.push([toolName, input, hint]);
        return { behavior: "deny", message: "no" };
      },
    });
    await new CodexAdapter(driver, { spawn: fake.spawn }).runTurn(p);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toEqual(["mcpElicitation", { serverName: "other", message: 'Allow the "other" MCP server to run tool "x"?' }, { kind: "other", summary: 'Allow the "other" MCP server to run tool "x"?' }]);
    expect(results).toEqual([{ action: "decline" }]);
    assertTurnEventInvariants(events);

    for (const mode of ["auto", "bypass"]) {
      let calledAgain = false;
      let resultAgain: unknown;
      const fake2 = fakeCodexServer({
        onTurn: async (ctx) => {
          resultAgain = await ctx.request("mcpServer/elicitation/request", { threadId: ctx.threadId, turnId: ctx.turnId, serverName: "other", message: "x" });
          return COMPLETED;
        },
      });
      const { p: p2, events: events2 } = baseParams({
        permissionMode: mode,
        requestPermission: async () => {
          calledAgain = true;
          return { behavior: "allow" };
        },
      });
      await new CodexAdapter(driver, { spawn: fake2.spawn }).runTurn(p2);
      expect(calledAgain).toBe(false);
      expect(resultAgain).toEqual({ action: "accept", content: {} });
      assertTurnEventInvariants(events2);
    }
  });

  it("uses thread/resume for the second turn (discards the response history)", async () => {
    const fake = fakeCodexServer({ onTurn: echoTurn });
    const { p, events } = baseParams({ agentSessionId: "thr_prev" });
    const result = await new CodexAdapter(driver, { spawn: fake.spawn }).runTurn(p);
    expect(fake.received.map((r) => r.method)).toEqual(["initialize", "initialized", "thread/resume", "turn/start"]);
    expect(fake.received[2]!.params).toEqual({ threadId: "thr_prev", cwd: "/tmp/repo", approvalPolicy: "on-request", sandbox: "workspace-write" });
    expect(events[0]!.payload).toEqual({ agentSessionId: "thr_prev" });
    expect(result.agentSessionId).toBe("thr_prev");
    assertTurnEventInvariants(events);
  });

  it("sends turn/interrupt on abort and emits turn_failed { error: interrupted } when interrupted", async () => {
    const fake = fakeCodexServer({
      onTurn: async (ctx) => {
        item(ctx, "item/started", { type: "commandExecution", id: "exec-1", status: "inProgress", command: "sleep 100", cwd: "/tmp/repo" });
        return null; // never finishes until an interrupt arrives
      },
    });
    const abort = new AbortController();
    const { p, events } = baseParams({ signal: abort.signal, requestPermission: () => new Promise(() => {}) });
    const run = new CodexAdapter(driver, { spawn: fake.spawn }).runTurn(p);
    await new Promise((r) => setTimeout(r, 20));
    abort.abort();
    const result = await run;
    const interrupt = fake.received.find((r) => r.method === "turn/interrupt")!;
    expect(interrupt.params).toEqual({ threadId: "thr_fake1", turnId: "turn_1" });
    expect(events.map((e) => e.type)).toEqual(["turn_started", "tool_started", "tool_finished", "turn_failed"]);
    expect(events.at(-2)!.payload).toEqual({ toolUseId: "exec-1", isError: true });
    expect(events.at(-1)!.payload).toEqual({ error: "interrupted" });
    expect(result.agentSessionId).toBe("thr_fake1");
    assertTurnEventInvariants(events);
  });

  it("still emits turn_failed { error: interrupted } without throwing when the interrupt is ignored (logs the stall via console.error)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const fake = fakeCodexServer({ onTurn: async () => null, onInterrupt: () => {} });
      const abort = new AbortController();
      const { p, events } = baseParams({ signal: abort.signal });
      const run = new CodexAdapter(driver, { spawn: fake.spawn, cancelTimeoutMs: 30 }).runTurn(p);
      await new Promise((r) => setTimeout(r, 20));
      abort.abort();
      const result = await run;
      expect(events.map((e) => e.type)).toEqual(["turn_started", "turn_failed"]);
      expect(events.at(-1)!.payload).toEqual({ error: "interrupted" });
      expect(result.agentSessionId).toBe("thr_fake1");
      assertTurnEventInvariants(events);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/did not stop within/));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("returns cancel without waiting for requestPermission when aborted while an approval is pending, then interrupted", async () => {
    const fake = fakeCodexServer({
      onTurn: async (ctx) => {
        item(ctx, "item/started", { type: "commandExecution", id: "exec-1", status: "inProgress", command: "curl example.com", cwd: "/tmp/repo" });
        const decision = await ctx.request("item/commandExecution/requestApproval", { itemId: "exec-1", command: "curl example.com", cwd: "/tmp/repo" });
        expect(decision).toEqual({ decision: "cancel" });
        return { id: "turn_1", status: "interrupted", items: [] };
      },
    });
    const abort = new AbortController();
    // requestPermission never resolves even after abort (reproduces an interrupt with the user never responding)
    const { p, events } = baseParams({ signal: abort.signal, requestPermission: () => new Promise(() => {}) });
    const run = new CodexAdapter(driver, { spawn: fake.spawn }).runTurn(p);
    await new Promise((r) => setTimeout(r, 20));
    abort.abort();
    const result = await run;
    expect(events.map((e) => e.type)).toEqual(["turn_started", "tool_started", "tool_finished", "turn_failed"]);
    expect(events.at(-1)!.payload).toEqual({ error: "interrupted" });
    expect(result.agentSessionId).toBe("thr_fake1");
    assertTurnEventInvariants(events);
  });

  it("emits turn_failed when turn/completed has a failed / unknown status", async () => {
    const fake = fakeCodexServer({ onTurn: async () => ({ id: "turn_1", status: "failed", error: { message: "model error" }, items: [] }) });
    const { p, events } = baseParams();
    await new CodexAdapter(driver, { spawn: fake.spawn }).runTurn(p);
    expect(events.at(-1)).toEqual({ type: "turn_failed", payload: { error: "model error" } });
    assertTurnEventInvariants(events);

    const weird = fakeCodexServer({ onTurn: async () => ({ id: "turn_1", status: "wat", items: [] }) });
    const { p: p2, events: e2 } = baseParams();
    await new CodexAdapter(driver, { spawn: weird.spawn }).runTurn(p2);
    expect(e2.at(-1)).toEqual({ type: "turn_failed", payload: { error: "turn status: wat" } });
    assertTurnEventInvariants(e2);
  });

  it("puts images as data URLs before the text", async () => {
    const fake = fakeCodexServer({ onTurn: echoTurn });
    const { p, events } = baseParams({ images: [{ data: "AAAA", mediaType: "image/png" }] });
    await new CodexAdapter(driver, { spawn: fake.spawn }).runTurn(p);
    expect(fake.received.find((r) => r.method === "turn/start")!.params.input).toEqual([
      { type: "image", url: "data:image/png;base64,AAAA" },
      { type: "text", text: "hello" },
    ]);
    assertTurnEventInvariants(events);
  });

  it("spawns codex app-server in p.cwd, passes CODEX_HOME, and drops API keys", async () => {
    const fake = fakeCodexServer({ onTurn: echoTurn });
    process.env.OPENAI_API_KEY = "sk-must-not-leak";
    process.env.CODEX_API_KEY = "sk-must-not-leak";
    try {
      const { p } = baseParams();
      await new CodexAdapter(driver, { spawn: fake.spawn }).runTurn(p);
      expect(fake.spawned).toHaveLength(1);
      expect(fake.spawned[0]).toMatchObject({ launch: { command: "codex", args: ["app-server"] }, cwd: "/tmp/repo" });
      expect(fake.spawned[0]!.env.CODEX_HOME).toBe("/tmp/profiles/cx");
      expect(fake.spawned[0]!.env.OPENAI_API_KEY).toBeUndefined();
      expect(fake.spawned[0]!.env.CODEX_API_KEY).toBeUndefined();
    } finally {
      delete process.env.OPENAI_API_KEY;
      delete process.env.CODEX_API_KEY;
    }
  });

  it("switches approvalPolicy / sandbox / sandboxPolicy per permission mode", async () => {
    const expected: Record<string, { approvalPolicy: string; sandbox: string; sandboxPolicy: { type: string } }> = {
      ask: { approvalPolicy: "on-request", sandbox: "workspace-write", sandboxPolicy: { type: "workspaceWrite" } },
      // auto / bypass are also on-request (with never, codex fails MCP tool calls without an approval request — measured)
      auto: { approvalPolicy: "on-request", sandbox: "workspace-write", sandboxPolicy: { type: "workspaceWrite" } },
      bypass: { approvalPolicy: "on-request", sandbox: "danger-full-access", sandboxPolicy: { type: "dangerFullAccess" } },
      unknown: { approvalPolicy: "on-request", sandbox: "workspace-write", sandboxPolicy: { type: "workspaceWrite" } },
    };
    for (const [mode, want] of Object.entries(expected)) {
      const fake = fakeCodexServer({ onTurn: echoTurn });
      const { p } = baseParams({ permissionMode: mode, model: "gpt-5.6-sol", effort: "high" });
      await new CodexAdapter(driver, { spawn: fake.spawn }).runTurn(p);
      expect(fake.received.find((r) => r.method === "thread/start")!.params).toEqual({
        cwd: "/tmp/repo",
        approvalPolicy: want.approvalPolicy,
        sandbox: want.sandbox,
        model: "gpt-5.6-sol",
      });
      expect(fake.received.find((r) => r.method === "turn/start")!.params).toMatchObject({
        approvalPolicy: want.approvalPolicy,
        sandboxPolicy: want.sandboxPolicy,
        model: "gpt-5.6-sol",
        effort: "high",
      });
    }
  });

  it("writes the MCP (send_user_file) entry to config.toml before spawn", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cx-"));
    let tomlAtSpawn: string | null = null;
    const fake = fakeCodexServer({ onTurn: echoTurn });
    const spawn: typeof fake.spawn = (launch, opts) => {
      tomlAtSpawn = fs.readFileSync(path.join(dir, "config.toml"), "utf8");
      return fake.spawn(launch, opts);
    };
    const { p } = baseParams({
      profileDir: dir,
      mcpServer: { command: "/usr/bin/node", args: ["cli.js", "mcp-server"], env: { TINY_SERVER_URL: "http://127.0.0.1:1", TINY_TOKEN: "t", TINY_SESSION_ID: "s1" } },
    });
    await new CodexAdapter(driver, { spawn }).runTurn(p);
    expect(tomlAtSpawn).toContain("[mcp_servers.tiny]");
    expect(tomlAtSpawn).toContain('command = "/usr/bin/node"');
    expect(tomlAtSpawn).toContain('args = ["cli.js", "mcp-server"]');
    expect(tomlAtSpawn).toContain('TINY_SESSION_ID = "s1"');
  });

  it("does not miss a turn/completed that arrives before the turn/start response", async () => {
    const fake = fakeCodexServer({ turnBeforeResponse: true, onTurn: echoTurn });
    const { p, events } = baseParams();
    await new CodexAdapter(driver, { spawn: fake.spawn }).runTurn(p);
    expect(events.at(-1)!.type).toBe("turn_completed");
    assertTurnEventInvariants(events);
  });

  it("throws before spawn when already aborted before the call (no events)", async () => {
    const fake = fakeCodexServer({ onTurn: echoTurn });
    const abort = new AbortController();
    abort.abort();
    const { p, events } = baseParams({ signal: abort.signal });
    await expect(new CodexAdapter(driver, { spawn: fake.spawn }).runTurn(p)).rejects.toThrow(/interrupted before/);
    expect(fake.spawned).toEqual([]);
    expect(events).toEqual([]);
  });

  /** Fails a test stuck short of the expected state with an error that names the cause */
  const withDeadline = async <T>(work: Promise<T>, ms: number, what: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timeout(${ms}ms): ${what}`)), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const mcpLaunch = (sessionId: string) => ({
    command: "/usr/bin/node",
    args: ["cli.js"],
    env: { TINY_SERVER_URL: "http://127.0.0.1:1", TINY_TOKEN: "t", TINY_SESSION_ID: sessionId },
  });

  /**
   * Scaffold that runs 2 turns concurrently in the same profileDir.
   * Neither turn finishes until `ctx.complete()` is called (= if the lock were held for the
   * whole turn, the second turn would never spawn), so where the lock is released can be
   * observed without sleeps.
   */
  function lockFixture(
    o: {
      mcpStartup?: "ready" | "failed" | "none";
      mcpLockTimeoutMs?: number;
      withMcp?: boolean;
      delayThreadStart?: () => Promise<void>;
      existingToml?: string;
    } = {},
  ) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cx-lock-"));
    const tomlPath = path.join(dir, "config.toml");
    if (o.existingToml) fs.writeFileSync(tomlPath, o.existingToml);

    const ctxs: FakeCodexCtx[] = [];
    const defer = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      return { promise, resolve };
    };
    const turnGates = [defer(), defer()];
    const hold = async (ctx: FakeCodexCtx) => {
      ctxs.push(ctx);
      turnGates[ctxs.length - 1]?.resolve();
      return null; // never finishes until ctx.complete() is called
    };
    const fake1 = fakeCodexServer({ onTurn: hold, mcpStartup: o.mcpStartup, delayThreadStart: o.delayThreadStart });
    const fake2 = fakeCodexServer({ onTurn: hold, mcpStartup: o.mcpStartup });

    let spawnCalls = 0;
    const spawn1 = defer();
    const spawn2 = defer();
    let tomlAtSpawn2: string | null = null;
    const spawn: typeof fake1.spawn = (launch, opts) => {
      spawnCalls += 1;
      if (spawnCalls === 1) {
        spawn1.resolve();
        return fake1.spawn(launch, opts);
      }
      try {
        tomlAtSpawn2 = fs.readFileSync(tomlPath, "utf8"); // right after turn 2 wrote config.toml
      } catch {
        tomlAtSpawn2 = null; // a turn without MCP never creates config.toml
      }
      spawn2.resolve();
      return fake2.spawn(launch, opts);
    };

    const adapter = new CodexAdapter(driver, { spawn, mcpLockTimeoutMs: o.mcpLockTimeoutMs });
    const mk = (sessionId: string) => baseParams({ profileDir: dir, mcpServer: o.withMcp === false ? null : mcpLaunch(sessionId) });
    const t1 = mk("s1");
    const t2 = mk("s2");
    return {
      tomlPath,
      ctxs,
      spawned1: spawn1.promise,
      spawned2: spawn2.promise,
      turn1Started: turnGates[0]!.promise,
      turn2Started: turnGates[1]!.promise,
      get spawnCalls() {
        return spawnCalls;
      },
      get tomlAtSpawn2() {
        return tomlAtSpawn2;
      },
      run1: adapter.runTurn(t1.p),
      run2: adapter.runTurn(t2.p),
      events1: t1.events,
      events2: t2.events,
    };
  }

  /** Confirms turn 2 has started running, then completes both turns (2 → 1 order) */
  async function finishBoth(f: ReturnType<typeof lockFixture>) {
    await withDeadline(f.turn2Started, 2000, "turn 2 turn/start");
    f.ctxs[1]!.complete(COMPLETED);
    await withDeadline(f.run2, 2000, "turn 2 completion");
    f.ctxs[0]!.complete(COMPLETED);
    await withDeadline(f.run1, 2000, "turn 1 completion");
    assertTurnEventInvariants(f.events1);
    assertTurnEventInvariants(f.events2);
  }

  it("releases the lock on tiny's MCP startupStatus (ready), so turn 2 spawns without waiting for turn 1 to complete", async () => {
    const f = lockFixture({ mcpStartup: "ready" });
    await withDeadline(f.spawned2, 2000, "turn 2 spawn");

    expect(f.spawnCalls).toBe(2);
    // Turn 1 is still running (the lock is held only until MCP startup, not the whole turn)
    expect(f.events1.map((e) => e.type)).not.toContain("turn_completed");
    expect(f.tomlAtSpawn2).toContain('TINY_SESSION_ID = "s2"');
    expect(fs.readFileSync(f.tomlPath, "utf8")).toContain('TINY_SESSION_ID = "s2"');

    await finishBoth(f);
    expect(fs.readFileSync(f.tomlPath, "utf8")).not.toContain("mcp_servers");
  });

  it("releases the lock even when startupStatus is failed (the turn proceeds even if MCP never starts)", async () => {
    const f = lockFixture({ mcpStartup: "failed" });
    await withDeadline(f.spawned2, 2000, "turn 2 spawn");
    expect(f.spawnCalls).toBe(2);
    expect(f.events1.map((e) => e.type)).not.toContain("turn_completed");
    await finishBoth(f);
  });

  it("releases the lock via mcpLockTimeoutMs when startupStatus never arrives", async () => {
    let openGate!: () => void;
    const gate = new Promise<void>((r) => (openGate = r));
    const f = lockFixture({ mcpStartup: "none", mcpLockTimeoutMs: 50, delayThreadStart: () => gate });

    await withDeadline(f.spawned1, 2000, "turn 1 spawn");
    expect(f.spawnCalls).toBe(1); // turn 2 only queued up waiting for the lock

    const t0 = Date.now();
    openGate(); // from here: turn 1's thread/start response → timer starts
    await withDeadline(f.spawned2, 2000, "turn 2 spawn");
    const elapsed = Date.now() - t0;

    expect(f.spawnCalls).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(40); // released by the timer, not immediately
    expect(f.events1.map((e) => e.type)).not.toContain("turn_completed");
    await finishBoth(f);
  });

  it("releases the lock on the thread/start response for a turn with null mcpServer (waits for neither startupStatus nor the timeout)", async () => {
    // No startupStatus, and the timeout is 60s = the only release path is the thread/start response
    const f = lockFixture({ withMcp: false, mcpStartup: "none", mcpLockTimeoutMs: 60_000 });
    await withDeadline(f.spawned2, 2000, "turn 2 spawn");
    expect(f.spawnCalls).toBe(2);
    expect(f.events1.map((e) => e.type)).not.toContain("turn_completed");
    expect(f.tomlAtSpawn2).toBeNull(); // config.toml was never written
    await finishBoth(f);
  });

  it("removes the tiny region from config.toml only when the profile's last turn ends", async () => {
    const f = lockFixture({ mcpStartup: "ready", existingToml: 'model = "gpt-5.6-sol"\n[features]\nweb_search = true\n' });
    await withDeadline(f.turn2Started, 2000, "turn 2 turn/start");

    // Complete only turn 2. Turn 1 is still running, so the region must stay
    f.ctxs[1]!.complete(COMPLETED);
    await withDeadline(f.run2, 2000, "turn 2 completion");
    const mid = fs.readFileSync(f.tomlPath, "utf8");
    expect(mid).toContain("[mcp_servers.tiny]");
    expect(mid).toContain('TINY_SESSION_ID = "s2"');

    // Only when the last turn ends is it removed (user settings remain)
    f.ctxs[0]!.complete(COMPLETED);
    await withDeadline(f.run1, 2000, "turn 1 completion");
    const after = fs.readFileSync(f.tomlPath, "utf8");
    expect(after).not.toContain("mcp_servers");
    expect(after).not.toContain("TINY_TOKEN");
    expect(after).not.toContain("TINY_SESSION_ID");
    expect(after).toContain('model = "gpt-5.6-sol"');
    expect(after).toContain("[features]\nweb_search = true");
    assertTurnEventInvariants(f.events1);
    assertTurnEventInvariants(f.events2);
  });

  it("removes [mcp_servers.tiny] from config.toml when the turn ends, keeping surrounding user settings", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cx-cleanup-"));
    const tomlPath = path.join(dir, "config.toml");
    fs.writeFileSync(tomlPath, 'model = "gpt-5.6-sol"\n[features]\nweb_search = true\n');
    const fake = fakeCodexServer({ onTurn: echoTurn });
    const { p } = baseParams({
      profileDir: dir,
      mcpServer: { command: "/usr/bin/node", args: ["cli.js"], env: { TINY_SERVER_URL: "http://127.0.0.1:1", TINY_TOKEN: "t", TINY_SESSION_ID: "s1" } },
    });
    await new CodexAdapter(driver, { spawn: fake.spawn }).runTurn(p);
    const toml = fs.readFileSync(tomlPath, "utf8");
    expect(toml).not.toContain("mcp_servers");
    expect(toml).not.toContain("TINY_TOKEN");
    expect(toml).not.toContain("TINY_SESSION_ID");
    expect(toml).toContain('model = "gpt-5.6-sol"');
    expect(toml).toContain("[features]\nweb_search = true");
  });

  it("throws without spawning when aborted while waiting for the lock, even once its turn comes (no events)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cx-lock-abort-"));
    let releaseThreadStart: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => (releaseThreadStart = resolve));
    const fake1 = fakeCodexServer({ onTurn: echoTurn, delayThreadStart: () => gate });
    const fake2 = fakeCodexServer({ onTurn: echoTurn });
    let spawnCalls = 0;
    const spawn: typeof fake1.spawn = (launch, opts) => (spawnCalls++ === 0 ? fake1.spawn(launch, opts) : fake2.spawn(launch, opts));

    const adapter = new CodexAdapter(driver, { spawn });
    const { p: p1 } = baseParams({ profileDir: dir });
    const abort2 = new AbortController();
    const { p: p2, events: events2 } = baseParams({ profileDir: dir, signal: abort2.signal });

    const run1 = adapter.runTurn(p1);
    const run2 = adapter.runTurn(p2);

    // Abort run2 while it is still waiting for the lock and has not spawned
    await new Promise((r) => setTimeout(r, 20));
    expect(spawnCalls).toBe(1);
    abort2.abort();

    releaseThreadStart!();
    await run1;
    await expect(run2).rejects.toThrow(/interrupted before/);
    expect(spawnCalls).toBe(1); // run2 never spawned
    expect(events2).toEqual([]);
  });

  it("lets a different profileDir proceed immediately, unaffected by the lock (within the same CodexAdapter instance)", async () => {
    const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cx-lock-a-"));
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cx-lock-b-"));
    let releaseThreadStart: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => (releaseThreadStart = resolve));
    const fakeSlow = fakeCodexServer({ onTurn: echoTurn, delayThreadStart: () => gate });
    const fakeFast = fakeCodexServer({ onTurn: echoTurn });
    // Route to a separate fake per profileDir (= CODEX_HOME)
    const spawn: typeof fakeSlow.spawn = (launch, opts) => (opts.env.CODEX_HOME === dir1 ? fakeSlow.spawn(launch, opts) : fakeFast.spawn(launch, opts));

    const adapter = new CodexAdapter(driver, { spawn });
    const { p: p1 } = baseParams({ profileDir: dir1 });
    const run1 = adapter.runTurn(p1);

    await new Promise((r) => setTimeout(r, 20));
    // dir1 is still waiting on its thread/start response, but the other profile's (dir2) turn completes unblocked
    const { p: p2 } = baseParams({ profileDir: dir2 });
    const result2 = await adapter.runTurn(p2);
    expect(result2.agentSessionId).toBe("thr_fake1");

    releaseThreadStart!();
    await run1;
  });

  it("ends with turn_failed { error: /exited before/ } instead of hanging when the codex process dies mid-turn", async () => {
    const fake = fakeCodexServer({
      onTurn: async (ctx) => {
        item(ctx, "item/started", { type: "commandExecution", id: "exec-1", status: "inProgress", command: "sleep 100", cwd: "/tmp/repo" });
        ctx.die(); // codex dies without ever emitting turn/completed
        return null;
      },
    });
    const { p, events } = baseParams();
    const result = await new CodexAdapter(driver, { spawn: fake.spawn }).runTurn(p);
    expect(events.map((e) => e.type)).toEqual(["turn_started", "tool_started", "tool_finished", "turn_failed"]);
    expect(events.at(-2)!.payload).toEqual({ toolUseId: "exec-1", isError: true });
    expect((events.at(-1)!.payload as { error: string }).error).toMatch(/exited before/);
    expect(result.agentSessionId).toBe("thr_fake1");
    assertTurnEventInvariants(events);
  });

  it("throws on abort during startup (initialize hanging), emits no events, and kills the process", async () => {
    const fake = fakeCodexServer({ hangInitialize: true, onTurn: echoTurn });
    const abort = new AbortController();
    const { p, events } = baseParams({ signal: abort.signal });
    const run = new CodexAdapter(driver, { spawn: fake.spawn }).runTurn(p);
    await new Promise((r) => setTimeout(r, 20));
    abort.abort();
    await expect(run).rejects.toThrow(/interrupted before the turn started/);
    expect(events).toEqual([]);
    expect(fake.killed).toBe(1);
  });
});
