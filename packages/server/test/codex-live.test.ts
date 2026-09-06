import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexRolloutCursor, codexThreadHolders, findCodexRollout, listCodexSessions, readCodexRollout } from "../src/codex-live.js";

const TID = "01a04e08-f742-7aa2-b039-b3a952f6ef9d";
const NOW = new Date("2026-09-01T01:00:00+09:00");

/** Measured record shapes (codex-cli 0.149.1 rollout; see HANDOFF Step 3) */
const L = {
  meta: { timestamp: "2026-08-29T15:00:05.582Z", type: "session_meta", payload: { id: TID, timestamp: "2026-08-29T15:00:05.582Z", cwd: "/Users/x/repo", originator: "codex_cli_rs", cli_version: "0.149.1" } },
  taskStart: { type: "event_msg", payload: { type: "task_started", turn_id: "t1", started_at: 1788015605, model_context_window: 258400 } },
  devNoise: { type: "response_item", payload: { type: "message", id: "m0", role: "user", content: [{ type: "input_text", text: "<recommended_plugins>noise</recommended_plugins>" }] } },
  user: { type: "event_msg", payload: { type: "user_message", message: "fix the failing test", images: [] } },
  reasoning: { type: "response_item", payload: { type: "reasoning", id: "rs1", summary: [], encrypted_content: "xxx" } },
  tool: { type: "response_item", payload: { type: "custom_tool_call", id: "ctc1", status: "completed", call_id: "call_1", name: "exec", input: "echo hi" } },
  toolOut: { type: "response_item", payload: { type: "custom_tool_call_output", id: "ctco1", call_id: "call_1", output: "hi" } },
  tokens1: { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, output_tokens: 81, total_tokens: 181 }, last_token_usage: { output_tokens: 81 } } } },
  commentary: { type: "event_msg", payload: { type: "agent_message", message: "Looking at the test first.", phase: "commentary" } },
  answer: { type: "event_msg", payload: { type: "agent_message", message: "done", phase: "final_answer" } },
  answerItem: { type: "response_item", payload: { type: "message", id: "m9", role: "assistant", content: [{ type: "output_text", text: "done" }], phase: "final_answer" } },
  tokens2: { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { output_tokens: 163 } } } },
  taskEnd: { type: "event_msg", payload: { type: "task_complete", turn_id: "t1", last_agent_message: "done", started_at: 1788015605, completed_at: 1788015616 } },
};
const jsonl = (records: unknown[]) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";

function writeRollout(root: string, records: unknown[], id = TID, day = "2026/09/01"): string {
  const dir = path.join(root, "sessions", day);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-09-01T00-00-00-${id}.jsonl`);
  fs.writeFileSync(file, jsonl(records));
  return file;
}

describe("codex-live", () => {
  it("lists recent sessions with cwd and the first user message as title, skipping empty ones", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cx-"));
    writeRollout(root, [L.meta, L.taskStart, L.devNoise, L.user]);
    writeRollout(root, [L.meta], "01a04e08-f742-7aa2-b039-b3a952f6ef00", "2026/08/31");
    const sessions = listCodexSessions(root, { now: NOW });
    expect(sessions).toHaveLength(2);
    const full = sessions.find((s) => s.agentSessionId === TID)!;
    expect(full).toMatchObject({ cwd: "/Users/x/repo", title: "fix the failing test", startedAt: "2026-08-29T15:00:05.582Z" });
    // yesterday's empty session is listed but unadoptable (title null)
    expect(sessions.find((s) => s.agentSessionId.endsWith("00"))!.title).toBeNull();
    // outside the window: nothing
    expect(listCodexSessions(root, { now: new Date("2026-09-05T00:00:00+09:00") })).toHaveLength(0);
    expect(findCodexRollout(root, TID, { now: NOW })).toContain(`${TID}.jsonl`);
    expect(findCodexRollout(root, "unknown-id", { now: NOW })).toBeNull();
  });

  it("finds the user message behind codex's ~64KB developer preamble", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cx-"));
    const noise = { type: "response_item", payload: { type: "message", id: "m0", role: "developer", content: [{ type: "input_text", text: "x".repeat(70 * 1024) }] } };
    writeRollout(root, [L.meta, L.taskStart, noise, L.user]);
    expect(listCodexSessions(root, { now: NOW })[0]!.title).toBe("fix the failing test");
  });

  it("maps the event stream to tiny events and reports the turn's state and tokens", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cx-"));
    const file = writeRollout(root, [L.meta, L.taskStart, L.devNoise, L.user, L.reasoning, L.tool, L.toolOut, L.tokens1, L.commentary]);
    const read1 = readCodexRollout(file, null)!;
    expect(read1.events.map((e) => e.type)).toEqual(["user_message", "tool_started", "tool_finished", "assistant_thinking"]);
    expect(read1.events[0]!.payload).toEqual({ text: "fix the failing test" });
    expect(read1.events[1]!.payload).toMatchObject({ toolName: "exec", toolUseId: "call_1", kind: "execute", summary: "echo hi" });
    expect(read1.events[2]!.payload).toEqual({ toolUseId: "call_1", isError: false, output: "hi" });
    expect(read1.events[3]!.payload).toEqual({ text: "Looking at the test first." });
    expect(read1.turn).toEqual({ startedAt: "2026-08-29T15:00:05.000Z", outputTokens: 81, open: true });
    expect(read1.title).toBe("fix the failing test");

    // Appends continue from the byte cursor; the finished turn closes with its final total
    fs.appendFileSync(file, jsonl([L.answer, L.answerItem, L.tokens2, L.taskEnd]));
    const read2 = readCodexRollout(file, read1.cursor)!;
    expect(read2.events.map((e) => e.type)).toEqual(["assistant_text"]);
    expect(read2.events[0]!.payload).toEqual({ text: "done" });
    expect(read2.turn).toEqual({ startedAt: null, outputTokens: 163, open: false });
    expect(readCodexRollout(file, read2.cursor)!.events).toEqual([]);
  });

  it("leaves a partially written last line for the next read", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cx-"));
    const file = writeRollout(root, [L.meta, L.user]);
    fs.appendFileSync(file, JSON.stringify(L.answer).slice(0, 20)); // torn write, no newline
    const read = readCodexRollout(file, null)!;
    expect(read.events.map((e) => e.type)).toEqual(["user_message"]);
    fs.appendFileSync(file, JSON.stringify(L.answer).slice(20) + "\n");
    const read2 = readCodexRollout(file, read.cursor)!;
    expect(read2.events.map((e) => e.type)).toEqual(["assistant_text"]);
    expect(codexRolloutCursor(file)).toBe(`b:${fs.statSync(file).size}`);
  });

  it("thread holders come from lsof and an absent lock means nobody", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cx-"));
    expect(codexThreadHolders(root, TID, () => "123\n")).toEqual([]);
    fs.mkdirSync(path.join(root, "thread-writer-locks"), { recursive: true });
    fs.writeFileSync(path.join(root, "thread-writer-locks", `${TID}.lock`), "");
    expect(codexThreadHolders(root, TID, () => "123\n456\n")).toEqual([123, 456]);
    expect(codexThreadHolders(root, TID, () => "")).toEqual([]);
    expect(codexThreadHolders(root, TID, () => { throw new Error("no lsof"); })).toEqual([]);
  });
});

/**
 * Paginated rollouts (measured 2026-09-06 on this Mac): `session_meta.history_mode: "paginated"`,
 * written by the TUI since codex-cli 0.147.0 and by `codex app-server` since 0.153.x. The
 * conversation is carried by `event_msg` `item_completed` records (PascalCase item types); the
 * legacy `user_message` / `agent_message` events are gone. The `response_item` custom_tool_call
 * pair still exists but is the unified-exec JS wrapper (one call → several CommandExecution items).
 */
describe("codex-live paginated rollouts (codex ≥ 0.147 TUI / ≥ 0.153 app-server)", () => {
  const SUB = "01a07452-04c1-7b42-a08f-faf90a676520";
  const item = (type: string, fields: Record<string, unknown>) => ({
    type: "event_msg",
    payload: { type: "item_completed", thread_id: TID, turn_id: "t1", item: { type, ...fields }, started_at_ms: 1788679748802, completed_at_ms: 1788679748802 },
  });
  const P = {
    meta: { timestamp: "2026-09-06T07:28:57.979Z", type: "session_meta", payload: { session_id: TID, id: TID, timestamp: "2026-09-06T07:28:57.979Z", cwd: "/Users/x/repo", originator: "codex-tui", cli_version: "0.153.4", source: "cli", thread_source: "user", history_mode: "paginated" } },
    subMeta: { timestamp: "2026-09-06T01:25:27.393Z", type: "session_meta", payload: { session_id: TID, id: SUB, parent_thread_id: TID, timestamp: "2026-09-06T01:25:27.393Z", cwd: "/Users/x/repo", originator: "codex-tui", cli_version: "0.153.4", source: { subagent: { thread_spawn: { parent_thread_id: TID, depth: 1, agent_nickname: "Copernicus" } } }, thread_source: "subagent", history_mode: "paginated" } },
    taskStart: L.taskStart,
    devNoise: { type: "response_item", payload: { type: "message", id: "m0", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for /Users/x/repo" }] } },
    user: item("UserMessage", { id: "u1", content: [{ type: "text", text: "why does this win?", text_elements: [] }] }),
    jsCall: { type: "response_item", payload: { type: "custom_tool_call", id: "ctc1", status: "completed", call_id: "call_1", name: "exec", input: "const results = await Promise.allSettled([tools.exec('date +%Y')])" } },
    cmd: item("CommandExecution", { id: "exec-1", process_id: "1", command: ["/bin/zsh", "-lc", "date +%Y"], cwd: "file:///Users/x/repo", source: "unified_exec_startup", status: "completed", stdout: "2026\n", stderr: "", aggregated_output: "2026\n", exit_code: 0 }),
    cmdFail: item("CommandExecution", { id: "exec-2", command: ["/bin/zsh", "-lc", "git status --short"], cwd: "file:///Users/x/repo", source: "unified_exec_startup", status: "failed", aggregated_output: "fatal: not a git repository\n", exit_code: 128 }),
    jsOut: { type: "response_item", payload: { type: "custom_tool_call_output", id: "ctco1", call_id: "call_1", output: "[{\"status\":\"fulfilled\"}]" } },
    tokens1: L.tokens1,
    commentary: item("AgentMessage", { id: "a1", content: [{ type: "Text", text: "Reading the site first." }], phase: "commentary" }),
    reasoningEmpty: item("Reasoning", { id: "r1", summary_text: [], raw_content: [] }),
    fileChange: item("FileChange", { id: "exec-3", changes: { "/Users/x/repo/scripts/a.py": { type: "add", content: "print(1)\n" }, "/Users/x/repo/b.py": { type: "update", content: "x" } } }),
    mcp: item("McpToolCall", { id: "exec-4", server: "chrome-devtools", tool: "new_page", arguments: { url: "https://e.x/" }, readOnlyHint: false, status: "failed", result: { content: [{ type: "text", text: "Could not connect to Chrome." }], isError: true } }),
    search: item("Extension", { id: "exec-5", kind: "web.search", query: "meme coins", action: { type: "search", query: "meme coins" }, results: [] }),
    imageView: item("ImageView", { id: "exec-6", path: "file:///tmp/x.png" }),
    answer: item("AgentMessage", { id: "a2", content: [{ type: "Text", text: "It wins by luck." }], phase: "final_answer" }),
    tokens2: L.tokens2,
    taskEnd: L.taskEnd,
  };

  it("lists a session by the first UserMessage item (no user_message event exists any more)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cx-"));
    writeRollout(root, [P.meta, P.taskStart, P.devNoise, P.user]);
    const sessions = listCodexSessions(root, { now: NOW });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ agentSessionId: TID, cwd: "/Users/x/repo", title: "why does this win?", startedAt: "2026-09-06T07:28:57.979Z" });

    // A multi-line first message (measured: people paste a paragraph) becomes a one-line title
    const multi = item("UserMessage", { id: "u2", content: [{ type: "text", text: "In this repo\n\nI let the model think of ideas, but " + "x".repeat(80) }] });
    writeRollout(root, [P.meta, P.taskStart, multi], "01a04e08-f742-7aa2-b039-b3a952f6ef33");
    const t = listCodexSessions(root, { now: NOW }).find((x) => x.agentSessionId.endsWith("33"))!.title!;
    expect(t.startsWith("In this repo I let the model think of ideas, but ")).toBe(true);
    expect(t).not.toContain("\n");
    expect(t.length).toBeLessThanOrEqual(60);
  });

  it("skips sub-agent threads (thread_source: subagent), which share the sessions directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cx-"));
    writeRollout(root, [P.subMeta, P.taskStart, item("UserMessage", { id: "u9", content: [{ type: "text", text: "review the diff" }] })], SUB, "2026/09/06");
    // the legacy shape also carried thread_source for sub-agents (measured 0.145.0)
    const legacySub = { ...L.meta, payload: { ...L.meta.payload, thread_source: "subagent" } };
    writeRollout(root, [legacySub, L.taskStart, L.user], "01a04e08-f742-7aa2-b039-b3a952f6ef11", "2026/09/06");
    expect(listCodexSessions(root, { now: new Date("2026-09-06T20:00:00+09:00") })).toEqual([]);
  });

  it("maps item_completed records to tiny events and ignores the unified-exec custom_tool_call pair", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cx-"));
    const file = writeRollout(root, [P.meta, P.taskStart, P.devNoise, P.user, P.jsCall, P.cmd, P.cmdFail, P.jsOut, P.tokens1, P.commentary, P.reasoningEmpty]);
    const read1 = readCodexRollout(file, null)!;
    expect(read1.events.map((e) => e.type)).toEqual([
      "user_message", "tool_started", "tool_finished", "tool_started", "tool_finished", "assistant_thinking",
    ]);
    expect(read1.events[0]!.payload).toEqual({ text: "why does this win?" });
    expect(read1.events[1]!.payload).toEqual({
      toolName: "commandExecution", toolUseId: "exec-1", kind: "execute", summary: "date +%Y",
      input: { command: "date +%Y", cwd: "/Users/x/repo" },
    });
    expect(read1.events[2]!.payload).toEqual({ toolUseId: "exec-1", isError: false, output: "2026\n" });
    expect(read1.events[3]!.payload).toMatchObject({ toolUseId: "exec-2", summary: "git status --short" });
    expect(read1.events[4]!.payload).toEqual({ toolUseId: "exec-2", isError: true, output: "fatal: not a git repository\n" });
    expect(read1.events[5]!.payload).toEqual({ text: "Reading the site first." });
    expect(read1.turn).toEqual({ startedAt: "2026-08-29T15:00:05.000Z", outputTokens: 81, open: true });
    expect(read1.title).toBe("why does this win?");

    fs.appendFileSync(file, jsonl([P.fileChange, P.mcp, P.search, P.imageView, P.answer, P.tokens2, P.taskEnd]));
    const read2 = readCodexRollout(file, read1.cursor)!;
    expect(read2.events.map((e) => e.type)).toEqual([
      "tool_started", "tool_finished", "tool_started", "tool_finished", "tool_started", "tool_finished", "assistant_text",
    ]);
    expect(read2.events[0]!.payload).toEqual({
      toolName: "fileChange", toolUseId: "exec-3", kind: "edit", summary: "a.py +1 files",
      input: { changes: [{ path: "/Users/x/repo/scripts/a.py", type: "add" }, { path: "/Users/x/repo/b.py", type: "update" }] },
    });
    expect(read2.events[1]!.payload).toEqual({ toolUseId: "exec-3", isError: false });
    expect(read2.events[2]!.payload).toEqual({
      toolName: "chrome-devtools_new_page", toolUseId: "exec-4", kind: "other", summary: "chrome-devtools_new_page", input: { url: "https://e.x/" },
    });
    expect(read2.events[3]!.payload).toEqual({ toolUseId: "exec-4", isError: true, output: "Could not connect to Chrome." });
    expect(read2.events[4]!.payload).toEqual({ toolName: "webSearch", toolUseId: "exec-5", kind: "fetch", summary: "meme coins", input: { query: "meme coins" } });
    expect(read2.events[5]!.payload).toEqual({ toolUseId: "exec-5", isError: false });
    expect(read2.events[6]!.payload).toEqual({ text: "It wins by luck." });
    expect(read2.turn).toEqual({ startedAt: null, outputTokens: 163, open: false });
    expect(readCodexRollout(file, read2.cursor)!.events).toEqual([]);
  });

  it("a mid-file read still knows the format from the session_meta line, so a lone custom_tool_call pair is not a tool", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-cx-"));
    const file = writeRollout(root, [P.meta, P.taskStart, P.user, P.jsCall, P.jsOut]);
    const read1 = readCodexRollout(file, null)!;
    expect(read1.events.map((e) => e.type)).toEqual(["user_message"]);
    const call2 = { type: "response_item", payload: { ...P.jsCall.payload, id: "ctc2", call_id: "call_2" } };
    const out2 = { type: "response_item", payload: { ...P.jsOut.payload, id: "ctco2", call_id: "call_2" } };
    fs.appendFileSync(file, jsonl([call2, out2]));
    expect(readCodexRollout(file, read1.cursor)!.events).toEqual([]);

    // The same append on a legacy rollout is still a tool call (the only record of it there)
    const legacy = writeRollout(root, [L.meta, L.taskStart, L.user], "01a04e08-f742-7aa2-b039-b3a952f6ef22");
    const l1 = readCodexRollout(legacy, null)!;
    fs.appendFileSync(legacy, jsonl([L.tool, L.toolOut]));
    expect(readCodexRollout(legacy, l1.cursor)!.events.map((e) => e.type)).toEqual(["tool_started", "tool_finished"]);
  });
});
