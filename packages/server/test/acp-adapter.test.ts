import { describe, expect, it } from "vitest";
import { AcpAdapter } from "../src/acp-adapter.js";
import type { RunTurnParams, TurnEventInput } from "../src/adapter.js";
import type { AgentDriver } from "../src/agents/index.js";
import { assertTurnEventInvariants } from "./adapter-contract.js";
import { fakeAcpAgent, type FakeAgentCtx } from "./fake-acp-agent.js";

const driver: AgentDriver = {
  id: "fake",
  label: "Fake",
  bin: "fake",
  adapter: "acp",
  launch: { command: "fake", args: ["acp"] },
  homeEnv: (dir) => ({ XDG_DATA_HOME: `${dir}/xdg/data` }),
  stripEnv: ["SECRET_KEY"],
  isLoggedIn: () => true,
  login: () => ({ bin: "fake", args: ["login"] }),
  attach: (s) => ({ bin: "fake", args: ["--session", s.agentSessionId] }),
  capabilities: () => ({
    models: [],
    efforts: [],
    permissionModes: [
      { id: "ask", label: "Ask first" },
      { id: "auto", label: "Auto-approve" },
    ],
    features: { images: true, usage: false, questions: false, attach: true, interrupt: true },
  }),
};

function baseParams(over: Partial<RunTurnParams> = {}): { p: RunTurnParams; events: TurnEventInput[] } {
  const events: TurnEventInput[] = [];
  const p: RunTurnParams = {
    agentSessionId: null,
    profileDir: "/tmp/profiles/oc",
    cwd: "/tmp/repo",
    permissionMode: "ask",
    model: null,
    effort: null,
    tinySessionId: "tiny-oc-1",
    prompt: "hello",
    emit: (ev) => events.push(ev),
    requestPermission: async () => ({ behavior: "allow" }),
    mcpServer: { command: "/usr/bin/node", args: ["cli.js", "mcp-server"], env: { TINY_SESSION_ID: "s1", TINY_TOKEN: "t" } },
    signal: new AbortController().signal,
    ...over,
  };
  return { p, events };
}

const upd = (ctx: FakeAgentCtx, update: Record<string, unknown>) => ctx.notify("session/update", { sessionId: ctx.sessionId, update });

// Replays one real opencode turn (bash → done)
async function bashTurn(ctx: FakeAgentCtx) {
  upd(ctx, { sessionUpdate: "available_commands_update", availableCommands: [] });
  upd(ctx, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
  upd(ctx, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I will " } });
  upd(ctx, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "run it." } });
  upd(ctx, { sessionUpdate: "tool_call", toolCallId: "toolu_1", title: "bash", kind: "execute", status: "pending", rawInput: { cwd: "/tmp/repo" } });
  upd(ctx, { sessionUpdate: "tool_call_update", toolCallId: "toolu_1", title: "echo hi", kind: "execute", status: "in_progress", rawInput: { command: "echo hi" } });
  upd(ctx, { sessionUpdate: "tool_call_update", toolCallId: "toolu_1", status: "completed", content: [{ type: "content", content: { type: "text", text: "hi" } }] });
  upd(ctx, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } });
  upd(ctx, { sessionUpdate: "usage_update", used: 16488, size: 200000, cost: { amount: 0.0228, currency: "USD" } });
  return { stopReason: "end_turn", usage: { inputTokens: 6, outputTokens: 4, totalTokens: 16492 } };
}

describe("AcpAdapter", () => {
  it("runs initialize → session/new → prompt and maps notifications to tiny events", async () => {
    const fake = fakeAcpAgent({ onPrompt: bashTurn });
    process.env.SECRET_KEY = "x";
    try {
      const adapter = new AcpAdapter(driver, { spawn: fake.spawn });
      const { p, events } = baseParams();
      const result = await adapter.runTurn(p);

      expect(result).toEqual({ agentSessionId: "ses_fake1", costUsd: 0.0228, resultText: "I will run it.\ndone" });
      expect(events.map((e) => e.type)).toEqual([
        "turn_started", "assistant_thinking", "assistant_text", "tool_started", "tool_finished", "assistant_text", "turn_completed",
      ]);
      expect(events[0]!.payload).toEqual({ agentSessionId: "ses_fake1" });
      expect(events[1]!.payload).toEqual({ text: "thinking" });
      expect(events[2]!.payload).toEqual({ text: "I will run it." });
      expect(events[3]!.payload).toMatchObject({ toolUseId: "toolu_1", toolName: "bash", kind: "execute", summary: "bash", input: { cwd: "/tmp/repo" } });
      expect(events[4]!.payload).toEqual({ toolUseId: "toolu_1", isError: false });
      expect(events[6]!.payload).toEqual({ costUsd: 0.0228, resultText: "I will run it.\ndone", contextTokens: 16488 });
      assertTurnEventInvariants(events);

      // spawn: the driver's launch, cwd, and agentEnv (drops stripEnv, adds the home env)
      expect(fake.spawned).toHaveLength(1);
      expect(fake.spawned[0]).toMatchObject({ launch: { command: "fake", args: ["acp"] }, cwd: "/tmp/repo" });
      expect(fake.spawned[0]!.env.XDG_DATA_HOME).toBe("/tmp/profiles/oc/xdg/data");
      expect(fake.spawned[0]!.env.SECRET_KEY).toBeUndefined();
      expect(fake.killed).toBe(1);

      // Shapes of initialize and session/new (mcpServers turns env into a name/value array)
      const init = fake.received.find((r) => r.method === "initialize")!;
      expect(init.params).toMatchObject({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "tiny" } });
      const nu = fake.received.find((r) => r.method === "session/new")!;
      expect(nu.params).toEqual({
        cwd: "/tmp/repo",
        mcpServers: [{ name: "tiny", command: "/usr/bin/node", args: ["cli.js", "mcp-server"], env: [{ name: "TINY_SESSION_ID", value: "s1" }, { name: "TINY_TOKEN", value: "t" }] }],
      });
      const prompt = fake.received.find((r) => r.method === "session/prompt")!;
      expect(prompt.params).toEqual({ sessionId: "ses_fake1", prompt: [{ type: "text", text: "hello" }] });
    } finally {
      delete process.env.SECRET_KEY;
    }
  });

  it("uses session/resume (no replay) for the second turn, with an empty array when mcpServers is absent", async () => {
    const fake = fakeAcpAgent({ onPrompt: bashTurn });
    const adapter = new AcpAdapter(driver, { spawn: fake.spawn });
    const { p, events } = baseParams({ agentSessionId: "ses_prev", mcpServer: null });
    const result = await adapter.runTurn(p);
    expect(result.agentSessionId).toBe("ses_prev");
    expect(fake.received.map((r) => r.method)).toEqual(["initialize", "session/resume", "session/prompt"]);
    expect(fake.received[1]!.params).toEqual({ sessionId: "ses_prev", cwd: "/tmp/repo", mcpServers: [] });
    expect(events[0]!.payload).toEqual({ agentSessionId: "ses_prev" });
    assertTurnEventInvariants(events);
  });

  it("uses session/load when there is no resume but loadSession, discarding replayed updates", async () => {
    const fake = fakeAcpAgent({
      initialize: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: {} } },
      onPrompt: bashTurn,
      onLoad: (ctx) => {
        upd(ctx, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old text" } });
        upd(ctx, { sessionUpdate: "tool_call", toolCallId: "old_tool", title: "old", kind: "execute", status: "completed" });
        upd(ctx, { sessionUpdate: "tool_call_update", toolCallId: "old_tool", status: "completed" });
      },
    });
    const adapter = new AcpAdapter(driver, { spawn: fake.spawn });
    const { p, events } = baseParams({ agentSessionId: "ses_prev" });
    await adapter.runTurn(p);
    expect(fake.received.map((r) => r.method)).toEqual(["initialize", "session/load", "session/prompt"]);
    // Updates during replay (session/load) are discarded; only live-turn updates remain
    expect(events.some((e) => e.type === "assistant_text" && String(e.payload.text).includes("old text"))).toBe(false);
    expect(events.some((e) => e.type === "tool_started" && e.payload.toolUseId === "old_tool")).toBe(false);
    expect(events.some((e) => e.type === "assistant_text" && String(e.payload.text).includes("I will run it."))).toBe(true);
    assertTurnEventInvariants(events);
  });

  it("throws on the second turn for an agent with neither resume nor load (before turn_started)", async () => {
    const fake = fakeAcpAgent({ initialize: { protocolVersion: 1, agentCapabilities: {} }, onPrompt: bashTurn });
    const adapter = new AcpAdapter(driver, { spawn: fake.spawn });
    const { p, events } = baseParams({ agentSessionId: "ses_prev" });
    await expect(adapter.runTurn(p)).rejects.toThrow(/cannot resume/);
    expect(events).toEqual([]);
    expect(fake.killed).toBe(1);
  });

  it("wires request_permission to requestPermission in ask mode: allow → allow_once / deny → reject_once", async () => {
    const options = [
      { optionId: "once", kind: "allow_once", name: "Allow once" },
      { optionId: "always", kind: "allow_always", name: "Always allow" },
      { optionId: "reject", kind: "reject_once", name: "Reject" },
    ];
    const toolCall = { toolCallId: "toolu_1", title: "echo hi", kind: "execute", status: "pending", rawInput: { command: "echo hi" } };
    const outcomes: unknown[] = [];
    const fake = fakeAcpAgent({
      onPrompt: async (ctx) => {
        upd(ctx, { sessionUpdate: "tool_call", toolCallId: "toolu_1", title: "bash", kind: "execute", status: "pending", rawInput: {} });
        outcomes.push(await ctx.request("session/request_permission", { sessionId: ctx.sessionId, toolCall, options }));
        outcomes.push(await ctx.request("session/request_permission", { sessionId: ctx.sessionId, toolCall, options }));
        upd(ctx, { sessionUpdate: "tool_call_update", toolCallId: "toolu_1", status: "failed" });
        return { stopReason: "end_turn" };
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
    await new AcpAdapter(driver, { spawn: fake.spawn }).runTurn(p);
    // toolName is the tool_call's first title (bash); summary is the title at request time (the actual command)
    expect(asked).toEqual([
      ["bash", { command: "echo hi" }, { kind: "execute", summary: "echo hi" }],
      ["bash", { command: "echo hi" }, { kind: "execute", summary: "echo hi" }],
    ]);
    expect(outcomes).toEqual([
      { outcome: { outcome: "selected", optionId: "once" } },
      { outcome: { outcome: "selected", optionId: "reject" } },
    ]);
    expect(events.find((e) => e.type === "tool_finished")!.payload).toEqual({ toolUseId: "toolu_1", isError: true });
    assertTurnEventInvariants(events);
  });

  it("picks allow_once without calling requestPermission in auto mode", async () => {
    let outcome: unknown;
    const fake = fakeAcpAgent({
      onPrompt: async (ctx) => {
        outcome = await ctx.request("session/request_permission", {
          sessionId: ctx.sessionId,
          toolCall: { toolCallId: "t", title: "rm x", kind: "delete" },
          options: [{ optionId: "a", kind: "allow_always", name: "" }, { optionId: "o", kind: "allow_once", name: "" }, { optionId: "r", kind: "reject_once", name: "" }],
        });
        return { stopReason: "end_turn" };
      },
    });
    let called = false;
    const { p, events } = baseParams({ permissionMode: "auto", requestPermission: async () => { called = true; return { behavior: "allow" }; } });
    await new AcpAdapter(driver, { spawn: fake.spawn }).runTurn(p);
    expect(called).toBe(false);
    expect(outcome).toEqual({ outcome: { outcome: "selected", optionId: "o" } });
    assertTurnEventInvariants(events);
  });

  it("puts images first as image content blocks and throws when images are unsupported", async () => {
    const fake = fakeAcpAgent({ onPrompt: bashTurn });
    const { p, events } = baseParams({ images: [{ data: "AAAA", mediaType: "image/png" }] });
    await new AcpAdapter(driver, { spawn: fake.spawn }).runTurn(p);
    expect(fake.received.find((r) => r.method === "session/prompt")!.params.prompt).toEqual([
      { type: "image", data: "AAAA", mimeType: "image/png" },
      { type: "text", text: "hello" },
    ]);
    assertTurnEventInvariants(events);
    const noImg = fakeAcpAgent({ initialize: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: false } } }, onPrompt: bashTurn });
    const { p: p2, events: events2 } = baseParams({ images: [{ data: "AAAA", mediaType: "image/png" }] });
    await expect(new AcpAdapter(driver, { spawn: noImg.spawn }).runTurn(p2)).rejects.toThrow(/image/);
    // Unsupported images throw right after initialize (before session/new, before turn_started), so no events at all
    expect(events2).toEqual([]);
  });

  it("sets model / effort via set_config_option, looking up configId from the configOptions category", async () => {
    const set: unknown[] = [];
    const fake = fakeAcpAgent({
      newSession: {
        configOptions: [
          { id: "model", name: "Model", category: "model", type: "select", currentValue: "a", options: [] },
          { id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: "high", options: [] },
          { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "build", options: [] },
        ],
      },
      onPrompt: bashTurn,
      onSetConfig: (params) => { set.push(params); return { configOptions: [] }; },
    });
    const { p } = baseParams({ model: "opencode/gpt-5.6-terra", effort: "max" });
    await new AcpAdapter(driver, { spawn: fake.spawn }).runTurn(p);
    expect(set).toEqual([
      { sessionId: "ses_fake1", configId: "model", value: "opencode/gpt-5.6-terra" },
      { sessionId: "ses_fake1", configId: "effort", value: "max" },
    ]);
    // Do nothing for agents without configOptions
    const none = fakeAcpAgent({ onPrompt: bashTurn });
    await new AcpAdapter(driver, { spawn: none.spawn }).runTurn(baseParams({ model: "x" }).p);
    expect(none.received.some((r) => r.method === "session/set_config_option")).toBe(false);
  });

  it("returns turn_failed instead of throwing when session/set_config_option fails (already after turn_started), keeping agentSessionId", async () => {
    const fake = fakeAcpAgent({
      newSession: { configOptions: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "a", options: [] }] },
      onPrompt: bashTurn,
      onSetConfig: () => {
        throw new Error("bad model id");
      },
    });
    const { p, events } = baseParams({ model: "x" });
    const result = await new AcpAdapter(driver, { spawn: fake.spawn }).runTurn(p);
    expect(events.map((e) => e.type)).toEqual(["turn_started", "turn_failed"]);
    expect(String(events.at(-1)!.payload.error)).toContain("bad model id");
    expect(result.agentSessionId).toBe("ses_fake1");
    assertTurnEventInvariants(events);
  });

  it("sends session/cancel on abort, emits turn_failed { error: interrupted } when cancelled, and answers pending permissions with cancelled", async () => {
    let permissionOutcome: unknown;
    const fake = fakeAcpAgent({
      onPrompt: async (ctx) => {
        upd(ctx, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "1\n2\n" } });
        upd(ctx, { sessionUpdate: "tool_call", toolCallId: "t1", title: "bash", kind: "execute", status: "pending" });
        permissionOutcome = await ctx.request("session/request_permission", {
          sessionId: ctx.sessionId, toolCall: { toolCallId: "t1", title: "sleep 100", kind: "execute" },
          options: [{ optionId: "once", kind: "allow_once", name: "" }],
        });
        return new Promise(() => {}); // never returns until cancelled (fake.cancelPending answers)
      },
    });
    const abort = new AbortController();
    const { p, events } = baseParams({
      signal: abort.signal,
      requestPermission: () => new Promise(() => {}), // the user never answers
    });
    const run = new AcpAdapter(driver, { spawn: fake.spawn }).runTurn(p);
    await new Promise((r) => setTimeout(r, 20));
    abort.abort();
    const result = await run;
    expect(fake.received.some((r) => r.method === "session/cancel")).toBe(true);
    expect(permissionOutcome).toEqual({ outcome: { outcome: "cancelled" } });
    expect(events.map((e) => e.type)).toEqual(["turn_started", "assistant_text", "tool_started", "tool_finished", "turn_failed"]);
    expect(events.at(-1)!.payload).toEqual({ error: "interrupted" });
    expect(result.agentSessionId).toBe("ses_fake1");
    assertTurnEventInvariants(events);
  });

  it("turns refusal into turn_failed, and emits both started/finished when a tool_call arrives with status completed", async () => {
    const fake = fakeAcpAgent({
      onPrompt: async (ctx) => {
        upd(ctx, { sessionUpdate: "tool_call", toolCallId: "t1", title: "read x", kind: "read", status: "completed", rawInput: { path: "/x" } });
        return { stopReason: "refusal" };
      },
    });
    const { p, events } = baseParams();
    await new AcpAdapter(driver, { spawn: fake.spawn }).runTurn(p);
    expect(events.map((e) => e.type)).toEqual(["turn_started", "tool_started", "tool_finished", "turn_failed"]);
    expect(events.at(-1)!.payload).toEqual({ error: "stopReason: refusal" });
    assertTurnEventInvariants(events);
  });

  it("throws with login in the message when session/new fails with an auth error (SessionManager turns it into auth_error)", async () => {
    const fake = fakeAcpAgent({ onPrompt: bashTurn });
    const origSpawn = fake.spawn;
    fake.spawn = (launch, opts) => {
      const proc = origSpawn(launch, opts);
      // Make the fake agent error on session/new: intercept conn and swap out request
      const origRequest = proc.conn.request.bind(proc.conn);
      proc.conn.request = (method, params) =>
        method === "session/new" ? Promise.reject(new Error("auth_required: run opencode auth login")) : origRequest(method, params);
      return proc;
    };
    const { p } = baseParams();
    await expect(new AcpAdapter(driver, { spawn: fake.spawn }).runTurn(p)).rejects.toThrow(/login/);
  });

  it("after turn_started, aborting with the agent stalling on cancel still yields turn_failed { error: interrupted } without throwing, keeping agentSessionId", async () => {
    const fake = fakeAcpAgent({
      onPrompt: async (ctx) => {
        upd(ctx, { sessionUpdate: "tool_call", toolCallId: "t1", title: "bash", kind: "execute", status: "pending" });
        return new Promise(() => {}); // ignores cancel and never returns
      },
      onCancel: () => {}, // reproduces an agent ignoring cancel
    });
    const abort = new AbortController();
    const { p, events } = baseParams({ signal: abort.signal });
    const run = new AcpAdapter(driver, { spawn: fake.spawn, cancelTimeoutMs: 50 }).runTurn(p);
    await new Promise((r) => setTimeout(r, 20)); // wait for session/prompt to be in flight before aborting
    abort.abort();
    const result = await run;
    expect(events.map((e) => e.type)).toEqual(["turn_started", "tool_started", "tool_finished", "turn_failed"]);
    expect(events.at(-2)!.payload).toEqual({ toolUseId: "t1", isError: true });
    expect(events.at(-1)!.payload).toEqual({ error: "interrupted" });
    expect(result.agentSessionId).toBe("ses_fake1");
    assertTurnEventInvariants(events);
  });

  it("throws before spawn when the signal was already aborted before runTurn (events empty since before turn_started)", async () => {
    const fake = fakeAcpAgent({ onPrompt: bashTurn });
    const abort = new AbortController();
    abort.abort();
    const { p, events } = baseParams({ signal: abort.signal });
    await expect(new AcpAdapter(driver, { spawn: fake.spawn }).runTurn(p)).rejects.toThrow(/interrupted before/);
    expect(fake.spawned).toEqual([]);
    expect(events).toEqual([]);
  });

  it("authenticates and retries when session/new fails with -32000 (auth required) (measured on droid)", async () => {
    const fake = fakeAcpAgent({ onPrompt: bashTurn, requireAuthUntilAuthenticated: true });
    const adapter = new AcpAdapter(driver, { spawn: fake.spawn });
    const { p, events } = baseParams();
    const result = await adapter.runTurn(p);
    expect(fake.received.map((r) => r.method)).toEqual(["initialize", "session/new", "authenticate", "session/new", "session/prompt"]);
    const authReq = fake.received.find((r) => r.method === "authenticate")!;
    // DEFAULT_INIT's authMethods is [{ id: "opencode-login" }], so when the driver has no
    // authMethodId its first entry is used
    expect(authReq.params).toEqual({ methodId: "opencode-login" });
    expect(result.agentSessionId).toBe("ses_fake1");
    assertTurnEventInvariants(events);
  });

  it("prefers the driver's authMethodId as the authenticate methodId", async () => {
    const fake = fakeAcpAgent({ onPrompt: bashTurn, requireAuthUntilAuthenticated: true });
    const droidLike: AgentDriver = { ...driver, authMethodId: "device-pairing" };
    const adapter = new AcpAdapter(droidLike, { spawn: fake.spawn });
    const { p } = baseParams();
    await adapter.runTurn(p);
    const authReq = fake.received.find((r) => r.method === "authenticate")!;
    expect(authReq.params).toEqual({ methodId: "device-pairing" });
  });

  it("throws the -32000 as-is without sending authenticate when initialize has no authMethods", async () => {
    const fake = fakeAcpAgent({
      initialize: { protocolVersion: 1, agentCapabilities: {} },
      onPrompt: bashTurn,
      requireAuthUntilAuthenticated: true,
    });
    const adapter = new AcpAdapter(driver, { spawn: fake.spawn });
    const { p, events } = baseParams();
    await expect(adapter.runTurn(p)).rejects.toThrow(/Authentication required/);
    expect(fake.received.map((r) => r.method)).toEqual(["initialize", "session/new"]);
    expect(events).toEqual([]);
  });

  it("also authenticates and retries on -32000 in the session/resume path", async () => {
    const fake = fakeAcpAgent({ onPrompt: bashTurn, requireAuthUntilAuthenticated: true });
    const adapter = new AcpAdapter(driver, { spawn: fake.spawn });
    const { p, events } = baseParams({ agentSessionId: "ses_prev", mcpServer: null });
    const result = await adapter.runTurn(p);
    expect(fake.received.map((r) => r.method)).toEqual([
      "initialize", "session/resume", "authenticate", "session/resume", "session/prompt",
    ]);
    expect(result.agentSessionId).toBe("ses_prev");
    assertTurnEventInvariants(events);
  });

  it("throws interrupted when aborted during startup (initialize hanging), with empty events and the process killed", async () => {
    const fake = fakeAcpAgent({ hangInitialize: true, onPrompt: bashTurn });
    const abort = new AbortController();
    const { p, events } = baseParams({ signal: abort.signal });
    const run = new AcpAdapter(driver, { spawn: fake.spawn }).runTurn(p);
    await new Promise((r) => setTimeout(r, 20));
    abort.abort();
    await expect(run).rejects.toThrow(/interrupted before the turn started/);
    expect(events).toEqual([]);
    expect(fake.killed).toBe(1);
  });
});

describe("AcpAdapter thought narration", () => {
  it("buffers streamed thought chunks into one narration, kept out of resultText", async () => {
    const fake = fakeAcpAgent({
      onPrompt: async (ctx) => {
        upd(ctx, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "The user wants" } });
        upd(ctx, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: " pong." } });
        upd(ctx, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "" } });
        upd(ctx, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "pong" } });
        return { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      },
    });
    const { p, events } = baseParams();
    const result = await new AcpAdapter(driver, { spawn: fake.spawn }).runTurn(p);
    expect(events.map((e) => e.type)).toEqual(["turn_started", "assistant_thinking", "assistant_text", "turn_completed"]);
    expect(events[1]!.payload).toEqual({ text: "The user wants pong." });
    expect(result.resultText).toBe("pong");
    assertTurnEventInvariants(events);
  });

  it("keeps interleaved thought and answer chunks in arrival order, and drops empty thought", async () => {
    const fake = fakeAcpAgent({
      onPrompt: async (ctx) => {
        upd(ctx, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "First." } });
        upd(ctx, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Then a note." } });
        upd(ctx, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "" } });
        upd(ctx, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Second." } });
        upd(ctx, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: " \n " } });
        return { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      },
    });
    const { p, events } = baseParams();
    const result = await new AcpAdapter(driver, { spawn: fake.spawn }).runTurn(p);
    expect(events.map((e) => e.type)).toEqual([
      "turn_started", "assistant_text", "assistant_thinking", "assistant_text", "turn_completed",
    ]);
    expect(events[2]!.payload).toEqual({ text: "Then a note." });
    expect(result.resultText).toBe("First.\nSecond.");
    assertTurnEventInvariants(events);
  });
});
