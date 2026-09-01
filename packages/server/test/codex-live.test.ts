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
