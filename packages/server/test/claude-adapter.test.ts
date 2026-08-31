import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeAdapter } from "../src/claude-adapter.js";
import type { RunTurnParams, TurnEventInput } from "../src/adapter.js";
import { assertTurnEventInvariants } from "./adapter-contract.js";

type CapturedOptions = Record<string, any>;

// Mimics the SDK's query(): streams a message sequence and calls canUseTool along the way
function fakeQuery(messages: any[], capture: { options?: CapturedOptions; canUseToolResult?: unknown }) {
  return (input: { prompt: unknown; options?: CapturedOptions }) => {
    capture.options = input.options;
    (capture as any).prompt = input.prompt;
    async function* gen() {
      for (const m of messages) {
        if (m.__callCanUseTool) {
          capture.canUseToolResult = await input.options!.canUseTool("Bash", { command: "rm -rf /tmp/x" }, {});
          continue;
        }
        yield m;
      }
    }
    return gen();
  };
}

function baseParams(over: Partial<RunTurnParams> = {}): { p: RunTurnParams; events: TurnEventInput[] } {
  const events: TurnEventInput[] = [];
  const p: RunTurnParams = {
    agentSessionId: null,
    profileDir: "/tmp/profiles/work",
    cwd: "/tmp/repo",
    permissionMode: "default", model: null, effort: null,
    tinySessionId: "tiny-session-1",
    prompt: "hello",
    emit: (ev) => events.push(ev),
    requestPermission: async () => ({ behavior: "allow" }),
    mcpServer: { command: "/usr/bin/node", args: ["cli.js", "mcp-server"], env: { TINY_SESSION_ID: "s1" } },
    signal: new AbortController().signal,
    ...over,
  };
  return { p, events };
}

const INIT = { type: "system", subtype: "init", session_id: "sess-uuid-1" };
const RESULT = {
  type: "result", subtype: "success", session_id: "sess-uuid-1", total_cost_usd: 0.12, result: "done",
  // The top level is the per-turn total (using it yields several hundred %). The last iteration is the current conversation size
  usage: {
    input_tokens: 30, cache_read_input_tokens: 500_000, cache_creation_input_tokens: 20_000, output_tokens: 900,
    iterations: [
      { input_tokens: 20, cache_read_input_tokens: 410_000, cache_creation_input_tokens: 15_000, output_tokens: 700 },
      { input_tokens: 10, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 5_000, output_tokens: 200 },
    ],
  },
};

describe("ClaudeAdapter", () => {
  it("converts the message sequence to normalized events and returns a TurnResult", async () => {
    const capture: any = {};
    const adapter = new ClaudeAdapter(fakeQuery([
      INIT,
      { type: "assistant", message: { content: [
        { type: "text", text: "Thinking it over" },
        { type: "tool_use", id: "tu1", name: "Read", input: { file_path: "/a" } },
      ] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", is_error: false }] } },
      RESULT,
    ], capture) as any);
    const { p, events } = baseParams();
    const result = await adapter.runTurn(p);

    expect(result).toEqual({ agentSessionId: "sess-uuid-1", costUsd: 0.12, resultText: "done" });
    expect(events.map((e) => e.type)).toEqual([
      "turn_started", "assistant_text", "tool_started", "tool_finished", "turn_completed",
    ]);
    expect(events[1]!.payload).toEqual({ text: "Thinking it over" });
    // kind / summary are display hints the server attaches (iOS need not know tool names)
    expect(events[2]!.payload).toMatchObject({ toolName: "Read", toolUseId: "tu1", kind: "read", summary: "a" });
    assertTurnEventInvariants(events);
    // contextTokens = input + cache_read + cache_creation + output (used for the context % display)
    expect(events[4]!.payload).toEqual({ costUsd: 0.12, resultText: "done", contextTokens: 95_210 });
  });

  it("passes CLAUDE_CONFIG_DIR in env, strips ANTHROPIC_API_KEY, and sets resume", async () => {
    const capture: any = {};
    process.env.ANTHROPIC_API_KEY = "sk-test-should-be-removed";
    try {
      const adapter = new ClaudeAdapter(fakeQuery([INIT, RESULT], capture) as any);
      const { p } = baseParams({ agentSessionId: "prev-sess" });
      await adapter.runTurn(p);
      expect(capture.options.env.CLAUDE_CONFIG_DIR).toBe("/tmp/profiles/work");
      expect(capture.options.env.ANTHROPIC_API_KEY).toBeUndefined();
      // Hooks in the user's own settings.json run inside this agent and inherit its env.
      // `tiny handoff` reads this to recognize it is inside an agent tiny started
      expect(capture.options.env.TINY_SESSION_ID).toBe("tiny-session-1");
      expect(capture.options.resume).toBe("prev-sess");
      expect(capture.options.cwd).toBe("/tmp/repo");
      expect(capture.options.permissionMode).toBe("default");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  // Claude Code reads ~/.claude.json when CLAUDE_CONFIG_DIR is unset, but $X/.claude.json when it is
  // set to $X. Setting it to the default data directory therefore breaks every turn of an adopted
  // (`tiny handoff`) session, whose profile points at exactly that directory
  it("omits CLAUDE_CONFIG_DIR entirely when the profile dir is Claude Code's default config dir", async () => {
    const prevHome = process.env.HOME;
    const prevCfg = process.env.CLAUDE_CONFIG_DIR;
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tiny-home-")));
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = "/srv/stale";
    try {
      const capture: any = {};
      const adapter = new ClaudeAdapter(fakeQuery([INIT, RESULT], capture) as any);
      const { p } = baseParams({ profileDir: path.join(home, ".claude") });
      await adapter.runTurn(p);
      // present-and-undefined or the string "undefined" would both break the child
      expect(Object.hasOwn(capture.options.env, "CLAUDE_CONFIG_DIR")).toBe(false);
      expect(capture.options.env.TINY_SESSION_ID).toBe("tiny-session-1");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prevCfg;
    }
  });

  it("wires canUseTool to requestPermission (deny)", async () => {
    const capture: any = {};
    const adapter = new ClaudeAdapter(fakeQuery([INIT, { __callCanUseTool: true }, RESULT], capture) as any);
    const asked: unknown[] = [];
    const { p } = baseParams({
      requestPermission: async (toolName, _input, hint) => {
        asked.push([toolName, hint]);
        return { behavior: "deny", message: "Rejected" };
      },
    });
    await adapter.runTurn(p);
    // Permission requests also carry kind / summary hints (used for banner and push wording)
    expect(asked).toEqual([["Bash", { kind: "execute", summary: "rm -rf /tmp/x" }]]);
    expect(capture.canUseToolResult).toEqual({ behavior: "deny", message: "Rejected" });
  });

  it("canUseTool: allow's updatedInput is returned to the SDK (AskUserQuestion answers)", async () => {
    const capture: any = {};
    const adapter = new ClaudeAdapter(fakeQuery([INIT, { __callCanUseTool: true }, RESULT], capture) as any);
    const updatedInput = { command: "ls", answers: { "Which one?": "Option A" } };
    const { p } = baseParams({
      requestPermission: async () => ({ behavior: "allow", updatedInput }),
    });
    await adapter.runTurn(p);
    expect(capture.canUseToolResult).toEqual({ behavior: "allow", updatedInput });
  });

  it("canUseTool: allow without updatedInput returns the original input", async () => {
    const capture: any = {};
    const adapter = new ClaudeAdapter(fakeQuery([INIT, { __callCanUseTool: true }, RESULT], capture) as any);
    const { p } = baseParams();   // requestPermission is a plain allow
    await adapter.runTurn(p);
    expect(capture.canUseToolResult).toEqual({ behavior: "allow", updatedInput: { command: "rm -rf /tmp/x" } });
  });

  it("passes send_user_file to the SDK as tiny mcp-server (stdio) (dropped the in-process MCP)", async () => {
    const capture: any = {};
    const adapter = new ClaudeAdapter(fakeQuery([INIT, RESULT], capture) as any);
    const { p } = baseParams();
    await adapter.runTurn(p);
    expect(capture.options.mcpServers).toEqual({
      tiny: { type: "stdio", command: "/usr/bin/node", args: ["cli.js", "mcp-server"], env: { TINY_SESSION_ID: "s1" } },
    });
    expect(capture.options.allowedTools).toEqual(["mcp__tiny__send_user_file"]);
  });

  it("passes no MCP when mcpServer is absent (works without file sending)", async () => {
    const capture: any = {};
    const adapter = new ClaudeAdapter(fakeQuery([INIT, RESULT], capture) as any);
    const { p } = baseParams({ mcpServer: null });
    await adapter.runTurn(p);
    expect(capture.options.mcpServers).toEqual({});
    expect(capture.options.allowedTools).toEqual([]);
  });

  it("emits turn_failed when the result subtype is not success", async () => {
    const capture: any = {};
    const adapter = new ClaudeAdapter(fakeQuery([
      INIT,
      { type: "result", subtype: "error_during_execution", session_id: "sess-uuid-1" },
    ], capture) as any);
    const { p, events } = baseParams();
    await adapter.runTurn(p);
    expect(events.map((e) => e.type)).toContain("turn_failed");
  });

  it("immediately aborts the SDK-side abortController when the signal is already aborted", async () => {
    const capture: any = {};
    const adapter = new ClaudeAdapter(fakeQuery([INIT, RESULT], capture) as any);
    const ac = new AbortController();
    ac.abort();
    const { p } = baseParams({ signal: ac.signal });
    await adapter.runTurn(p);
    expect(capture.options.abortController.signal.aborted).toBe(true);
  });

  it("passes a string prompt without images and a content-blocks user message with images", async () => {
    const capture1: any = {};
    const adapter1 = new ClaudeAdapter(fakeQuery([INIT, RESULT], capture1) as any);
    await adapter1.runTurn(baseParams().p);
    expect(capture1.prompt).toBe("hello");

    const capture2: any = {};
    const adapter2 = new ClaudeAdapter(fakeQuery([INIT, RESULT], capture2) as any);
    const { p } = baseParams({
      prompt: "Look at this image",
      images: [{ data: "QUJD", mediaType: "image/png" }],
    });
    await adapter2.runTurn(p);
    expect(typeof capture2.prompt).not.toBe("string");
    const messages: any[] = [];
    for await (const m of capture2.prompt) messages.push(m);
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe("user");
    expect(messages[0].message.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
      { type: "text", text: "Look at this image" },
    ]);
  });
});
