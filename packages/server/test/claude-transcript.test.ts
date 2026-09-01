import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findTranscript, newestTurn, readTranscript, readTranscriptCursor } from "../src/claude-transcript.js";

const SID = "3424c289-0fc1-4ec3-a0ca-3e5f324839fa";

function writeJsonl(file: string, records: Array<Record<string, unknown>>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function sample(): Array<Record<string, unknown>> {
  return [
    { type: "last-prompt", leafUuid: "u2", sessionId: SID },
    { type: "ai-title", aiTitle: "Handoff design", sessionId: SID },
    {
      type: "user", uuid: "u1", parentUuid: null, timestamp: "2026-08-31T03:25:11.588Z",
      message: { role: "user", content: "hello there" },
    },
    {
      type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: "2026-08-31T03:25:26.265Z",
      message: {
        model: "claude-opus-5",
        content: [
          { type: "text", text: "hi back" },
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/tmp/x" } },
        ],
      },
    },
    {
      type: "user", uuid: "u2", parentUuid: "a1", timestamp: "2026-08-31T03:25:30.000Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] },
    },
  ];
}

describe("claude-transcript", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-tr-"));
  });

  it("finds the transcript by encoded cwd", () => {
    const cwd = "/srv/a/ghq/github.com/x";
    const file = path.join(root, "projects", "-srv-a-ghq-github-com-x", `${SID}.jsonl`);
    writeJsonl(file, sample());
    expect(findTranscript(root, cwd, SID)).toBe(file);
  });

  it("falls back to scanning projects/ when the encoding does not match", () => {
    const file = path.join(root, "projects", "some-other-name", `${SID}.jsonl`);
    writeJsonl(file, sample());
    expect(findTranscript(root, "/srv/a/whatever", SID)).toBe(file);
  });

  it("returns null when there is no transcript", () => {
    expect(findTranscript(root, "/srv/a/x", SID)).toBeNull();
  });

  it("converts user, assistant text and tool records into events", () => {
    const file = path.join(root, "projects", "-srv-a-x", `${SID}.jsonl`);
    writeJsonl(file, sample());
    const r = readTranscript(file);
    expect(r.title).toBe("Handoff design");
    expect(r.cursor).toBe("u2");
    expect(r.events.map((e) => e.type)).toEqual([
      "user_message", "assistant_text", "tool_started", "tool_finished",
    ]);
    expect(r.events[0]!.payload.text).toBe("hello there");
    expect(r.events[1]!.payload.text).toBe("hi back");
    expect(r.events[2]!.payload.toolName).toBe("Read");
    expect(r.events[2]!.payload.kind).toBe("read");
    expect(r.events[2]!.payload.summary).toBe("x");
    expect(r.events[3]!.payload.toolUseId).toBe("t1");
  });

  it("reads only records after sinceUuid", () => {
    const file = path.join(root, "projects", "-srv-a-x", `${SID}.jsonl`);
    writeJsonl(file, sample());
    const r = readTranscript(file, { sinceUuid: "a1" });
    expect(r.events.map((e) => e.type)).toEqual(["tool_finished"]);
    expect(r.cursor).toBe("u2");
  });

  it("keeps only the last `turns` human turns on a first read", () => {
    const many: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 10; i++) {
      many.push({ type: "user", uuid: `u${i}`, message: { role: "user", content: `m${i}` } });
    }
    const file = path.join(root, "projects", "-srv-a-x", `${SID}.jsonl`);
    writeJsonl(file, many);
    const r = readTranscript(file, { turns: 3 });
    expect(r.events).toHaveLength(3);
    expect(r.events[0]!.payload.text).toBe("m7");
    expect(r.cursor).toBe("u9");
  });

  // The point of a backfill is the conversation. Slicing by record count on a real transcript
  // yields almost nothing but tool traffic, so slice by what the person actually said
  it("counts human turns, not records, so tool traffic cannot crowd out the conversation", () => {
    const records: Array<Record<string, unknown>> = [];
    for (let turn = 0; turn < 4; turn++) {
      records.push({ type: "user", uuid: `u${turn}`, message: { role: "user", content: `ask ${turn}` } });
      // each turn drags along a pile of tool traffic
      for (let k = 0; k < 20; k++) {
        records.push({
          type: "assistant", uuid: `a${turn}-${k}`,
          message: { content: [{ type: "tool_use", id: `t${turn}-${k}`, name: "Read", input: { file_path: "/srv/x" } }] },
        });
        records.push({
          type: "user", uuid: `r${turn}-${k}`,
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${turn}-${k}`, is_error: false }] },
        });
      }
    }
    const file = path.join(root, "projects", "-srv-a-x", `${SID}.jsonl`);
    writeJsonl(file, records);
    const r = readTranscript(file, { turns: 2 });
    const said = r.events.filter((e) => e.type === "user_message").map((e) => e.payload.text);
    expect(said).toEqual(["ask 2", "ask 3"]);
  });

  // Every real transcript carries 1-9 isMeta records: Claude Code's own interjections, not anything
  // a person typed. They must not count as turns, and must not reach the client as user messages
  it("drops isMeta records and keeps the real ones around them", () => {
    const records: Array<Record<string, unknown>> = [];
    records.push({ type: "user", uuid: "u0", message: { role: "user", content: "the real question" } });
    for (let k = 0; k < 3; k++) {
      records.push({ type: "user", uuid: `m${k}`, isMeta: true, message: { role: "user", content: `<meta ${k}>` } });
    }
    records.push({ type: "assistant", uuid: "a0", message: { content: [{ type: "text", text: "the real answer" }] } });
    const file = path.join(root, "projects", "-srv-a-x", `${SID}.jsonl`);
    writeJsonl(file, records);
    const r = readTranscript(file, { turns: 2 });
    expect(r.events.map((e) => e.payload.text)).toEqual(["the real question", "the real answer"]);
    // and the cursor still covers them, so the next read does not offer them again
    expect(r.cursor).toBe("a0");
  });

  it("does not take a title from an isMeta record", () => {
    const file = path.join(root, "projects", "-srv-a-x", `${SID}.jsonl`);
    writeJsonl(file, [
      { type: "user", uuid: "m0", isMeta: true, message: { role: "user", content: "Caveat: generated while running local commands" } },
      { type: "user", uuid: "u0", message: { role: "user", content: "what the person asked" } },
    ]);
    expect(readTranscript(file).title).toBe("what the person asked");
  });

  // The Nth turn is included, not cut away: starting after it strands a tool_finished whose
  // tool_started was never imported
  it("includes the record that starts the oldest kept turn", () => {
    const records: Array<Record<string, unknown>> = [];
    for (let turn = 0; turn < 3; turn++) {
      records.push({ type: "user", uuid: `u${turn}`, message: { role: "user", content: `ask ${turn}` } });
      records.push({
        type: "assistant", uuid: `a${turn}`,
        message: { content: [{ type: "tool_use", id: `t${turn}`, name: "Read", input: { file_path: "/srv/x" } }] },
      });
      records.push({
        type: "user", uuid: `r${turn}`,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${turn}`, is_error: false }] },
      });
    }
    const file = path.join(root, "projects", "-srv-a-x", `${SID}.jsonl`);
    writeJsonl(file, records);
    const r = readTranscript(file, { turns: 2 });
    // starts at "ask 1" — and every tool_finished it contains has its tool_started ahead of it
    expect(r.events.map((e) => e.type)).toEqual([
      "user_message", "tool_started", "tool_finished",
      "user_message", "tool_started", "tool_finished",
    ]);
    expect(r.events[0]!.payload.text).toBe("ask 1");
  });

  it("caps a first read at maxRecords, keeping the newest", () => {
    const records: Array<Record<string, unknown>> = [];
    records.push({ type: "user", uuid: "u0", message: { role: "user", content: "ask" } });
    for (let k = 0; k < 50; k++) {
      records.push({
        type: "assistant", uuid: `a${k}`,
        message: { content: [{ type: "text", text: `t${k}` }] },
      });
    }
    const file = path.join(root, "projects", "-srv-a-x", `${SID}.jsonl`);
    writeJsonl(file, records);
    const r = readTranscript(file, { turns: 10, maxRecords: 5 });
    expect(r.events.map((e) => e.payload.text)).toEqual(["t45", "t46", "t47", "t48", "t49"]);
    expect(r.cursor).toBe("a49");
  });

  it("takes the whole conversation when it has fewer turns than asked for", () => {
    const file = path.join(root, "projects", "-srv-a-x", `${SID}.jsonl`);
    writeJsonl(file, sample());
    const r = readTranscript(file, { turns: 10 });
    expect(r.events.map((e) => e.type)).toEqual([
      "user_message", "assistant_text", "tool_started", "tool_finished",
    ]);
  });

  it("readTranscriptCursor returns the tail without producing events", () => {
    const file = path.join(root, "projects", "-srv-a-x", `${SID}.jsonl`);
    writeJsonl(file, sample());
    expect(readTranscriptCursor(file)).toBe("u2");
    expect(readTranscriptCursor(path.join(root, "no-such.jsonl"))).toBeNull();
  });

  it("survives malformed lines and unknown record types", () => {
    const file = path.join(root, "projects", "-srv-a-x", `${SID}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      "{not json",
      JSON.stringify({ type: "atis-latch", sessionId: SID }),
      JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "ok" } }),
      "",
    ].join("\n"));
    const r = readTranscript(file);
    expect(r.events.map((e) => e.type)).toEqual(["user_message"]);
  });

  it("falls back to the first user message when there is no ai-title", () => {
    const file = path.join(root, "projects", "-srv-a-x", `${SID}.jsonl`);
    writeJsonl(file, [
      { type: "user", uuid: "u1", message: { role: "user", content: "a".repeat(100) } },
    ]);
    expect(readTranscript(file).title).toHaveLength(60);
  });

  it("classifies tool calls the same way the live adapter does", () => {
    const file = path.join(root, "projects", "-srv-a-x", `${SID}.jsonl`);
    writeJsonl(file, [
      {
        type: "assistant", uuid: "a1",
        message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { description: "run the tests" } }] },
      },
    ]);
    const ev = readTranscript(file).events[0]!;
    expect(ev.type).toBe("tool_started");
    expect(ev.payload.kind).toBe("execute");
    expect(ev.payload.summary).toBe("run the tests");
  });

  it("imports nothing when sinceUuid is no longer in the transcript", () => {
    const file = path.join(root, "projects", "-srv-a-x", `${SID}.jsonl`);
    writeJsonl(file, sample());
    // a cursor from a transcript that was forked or rotated away
    const r = readTranscript(file, { sinceUuid: "gone-forever" });
    expect(r.events).toEqual([]);
    // the cursor still advances so the next sync resumes correctly
    expect(r.cursor).toBe("u2");
  });

  it("emits one tool_finished per tool_result in a user record", () => {
    const file = path.join(root, "projects", "-srv-a-x", `${SID}.jsonl`);
    writeJsonl(file, [
      {
        type: "user", uuid: "u1",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", is_error: false },
            { type: "tool_result", tool_use_id: "t2", is_error: true },
          ],
        },
      },
    ]);
    const r = readTranscript(file);
    expect(r.events.map((e) => e.type)).toEqual(["tool_finished", "tool_finished"]);
    expect(r.events[0]!.payload.toolUseId).toBe("t1");
    expect(r.events[0]!.payload.isError).toBe(false);
    expect(r.events[1]!.payload.toolUseId).toBe("t2");
    expect(r.events[1]!.payload.isError).toBe(true);
  });

  it("skips empty assistant text blocks", () => {
    const file = path.join(root, "projects", "-srv-a-x", `${SID}.jsonl`);
    writeJsonl(file, [
      {
        type: "assistant", uuid: "a1",
        message: { content: [{ type: "text", text: "" }, { type: "text", text: "real" }] },
      },
    ]);
    const r = readTranscript(file);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.payload.text).toBe("real");
  });

  it("returns nothing for a transcript of only bookkeeping records", () => {
    const file = path.join(root, "projects", "-srv-a-x", `${SID}.jsonl`);
    writeJsonl(file, [
      { type: "mode", mode: "normal", sessionId: SID },
      { type: "permission-mode", permissionMode: "default", sessionId: SID },
      { type: "file-history-snapshot", sessionId: SID },
    ]);
    const r = readTranscript(file);
    expect(r.events).toEqual([]);
    expect(r.title).toBeNull();
    expect(r.cursor).toBeNull();
  });

  // `!cmd` in Claude Code is recorded as plain user records with no isMeta / promptSource marker.
  // They are operation log, not dialogue, and must render as tool activity like everything else
  describe("bash blocks (!cmd)", () => {
    it("turns a bash-input/bash-stdout pair into a linked tool_started/tool_finished", () => {
      const file = path.join(root, "projects", "-srv-a-x", `${SID}.jsonl`);
      writeJsonl(file, [
        {
          type: "user", uuid: "b1",
          message: { role: "user", content: "<bash-input>tiny handoff</bash-input>" },
        },
        {
          type: "user", uuid: "b2",
          message: { role: "user", content: "<bash-stdout>Handed off: abc123</bash-stdout><bash-stderr></bash-stderr>" },
        },
      ]);
      const r = readTranscript(file);
      expect(r.events.map((e) => e.type)).toEqual(["tool_started", "tool_finished"]);
      const started = r.events[0]!;
      const finished = r.events[1]!;
      expect(started.payload.kind).toBe("execute");
      expect(started.payload.summary).toBe("tiny handoff");
      expect(started.payload.toolUseId).toBe(finished.payload.toolUseId);
      expect(started.payload.toolUseId).toBe("b1");
    });

    it("sets isError true only when bash-stderr is non-empty", () => {
      const file = path.join(root, "projects", "-srv-a-x", `${SID}.jsonl`);
      writeJsonl(file, [
        { type: "user", uuid: "b1", message: { role: "user", content: "<bash-input>false</bash-input>" } },
        {
          type: "user", uuid: "b2",
          message: { role: "user", content: "<bash-stdout></bash-stdout><bash-stderr>boom</bash-stderr>" },
        },
      ]);
      const r = readTranscript(file);
      expect(r.events.find((e) => e.type === "tool_finished")!.payload.isError).toBe(true);
    });

    it("drops a bash-stdout with no pending bash-input", () => {
      const file = path.join(root, "projects", "-srv-a-x", `${SID}.jsonl`);
      writeJsonl(file, [
        {
          type: "user", uuid: "b1",
          message: { role: "user", content: "<bash-stdout>orphan</bash-stdout><bash-stderr></bash-stderr>" },
        },
      ]);
      const r = readTranscript(file);
      expect(r.events).toEqual([]);
    });

    it("still emits tool_started for a bash-input with no following stdout", () => {
      const file = path.join(root, "projects", "-srv-a-x", `${SID}.jsonl`);
      writeJsonl(file, [
        { type: "user", uuid: "b1", message: { role: "user", content: "<bash-input>tiny handoff</bash-input>" } },
      ]);
      const r = readTranscript(file);
      expect(r.events.map((e) => e.type)).toEqual(["tool_started"]);
    });

    it("does not count bash blocks toward the human-turn backfill window", () => {
      const records: Array<Record<string, unknown>> = [];
      for (let k = 0; k < 5; k++) {
        records.push({ type: "user", uuid: `bi${k}`, message: { role: "user", content: "<bash-input>ls</bash-input>" } });
        records.push({
          type: "user", uuid: `bo${k}`,
          message: { role: "user", content: "<bash-stdout>ok</bash-stdout><bash-stderr></bash-stderr>" },
        });
      }
      records.push({ type: "user", uuid: "u0", message: { role: "user", content: "the real question" } });
      const file = path.join(root, "projects", "-srv-a-x", `${SID}.jsonl`);
      writeJsonl(file, records);
      const r = readTranscript(file, { turns: 1 });
      const said = r.events.filter((e) => e.type === "user_message").map((e) => e.payload.text);
      expect(said).toEqual(["the real question"]);
    });

    it("keeps an ordinary message that merely mentions <bash-input> as conversation", () => {
      const file = path.join(root, "projects", "-srv-a-x", `${SID}.jsonl`);
      writeJsonl(file, [
        {
          type: "user", uuid: "u1",
          message: { role: "user", content: "what does <bash-input> even mean here?" },
        },
      ]);
      const r = readTranscript(file);
      expect(r.events).toEqual([
        { type: "user_message", payload: { text: "what does <bash-input> even mean here?" } },
      ]);
    });
  });

  it("reports peer msg_ids without turning the peer record into a user_message", () => {
    const file = path.join(root, "projects", "-srv-app", `${SID}.jsonl`);
    writeJsonl(file, [
      { type: "user", uuid: "u1", message: { role: "user", content: "typed in the terminal" } },
      {
        type: "user", uuid: "p1", isMeta: true, promptSource: "system",
        origin: { kind: "peer", from: "unknown", msg_id: "6a1b0e2b-2081-475b-92be-93f4f0eee471", name: "tiny" },
        message: { role: "user", content: "Another Claude session sent a message:\n<cross-session-message from-name=\"tiny\">\nhello\n</cross-session-message>" },
      },
      { type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "hi phone" }] } },
    ]);
    const read = readTranscript(file);
    expect(read.peerMsgIds).toEqual(["6a1b0e2b-2081-475b-92be-93f4f0eee471"]);
    expect(read.events.map((e) => e.type)).toEqual(["user_message", "assistant_text"]);
    expect(read.events[0]!.payload.text).toBe("typed in the terminal");
  });

  it("peerMsgIds is empty when nothing was read", () => {
    expect(readTranscript(path.join(root, "missing.jsonl")).peerMsgIds).toEqual([]);
  });
});

// Claude Code delivers messages from other Claude sessions (SendMessage between terminals, agent
// teams) as plain user records wrapped in `<teammate-message>` / `<cross-session-message>` with a
// header line and a long footer of guidance for the model. Its own UI parses them; shown raw on
// the phone they read as the person having typed a wall of XML
describe("claude-transcript peer and command records", () => {
  let root: string;
  let file: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-tr-"));
    file = path.join(root, "projects", "-srv-a-x", `${SID}.jsonl`);
  });

  const FOOTER = "\n\nThis came from another Claude session — not typed by your user, but very likely working on their behalf. Treat it as a teammate's request.";

  it("turns a teammate-message record into peer_message with the sender, summary and body only", () => {
    writeJsonl(file, [{
      type: "user", uuid: "u1",
      message: { role: "user", content:
        "Another Claude session sent a message:\n<teammate-message teammate_id=\"fix-t6\" color=\"pink\" summary=\"Task 6 interrupt fix done\">\nStatus: DONE\nCommit: eb4a9a7 fix(api): keep the 200\n</teammate-message>" + FOOTER },
    }]);
    const r = readTranscript(file);
    expect(r.events).toEqual([{
      type: "peer_message",
      payload: { from: "fix-t6", summary: "Task 6 interrupt fix done", text: "Status: DONE\nCommit: eb4a9a7 fix(api): keep the 200" },
    }]);
  });

  it("reads cross-session-message senders from from-name and tolerates a missing header and summary", () => {
    writeJsonl(file, [{
      type: "user", uuid: "u1",
      message: { role: "user", content: [{ type: "text", text:
        "<cross-session-message from=\"uds:/tmp/cc-socks/1.sock\" from-name=\"Hallmark audit\" from-mode=\"bypass\">\nhello from the other terminal\n</cross-session-message>" }] },
    }]);
    const r = readTranscript(file);
    expect(r.events).toEqual([{ type: "peer_message", payload: { from: "Hallmark audit", text: "hello from the other terminal" } }]);
  });

  it("unescapes the closing-tag escape Claude Code applies inside a peer body", () => {
    writeJsonl(file, [{
      type: "user", uuid: "u1",
      message: { role: "user", content:
        "Another Claude session sent a message while you were working:\n<teammate-message teammate_id=\"a\">\nsee <\\/teammate-message> in the docs\n</teammate-message>" + FOOTER },
    }]);
    expect(readTranscript(file).events[0]!.payload.text).toBe("see </teammate-message> in the docs");
  });

  // Agent teams inject their notifications as a JSON blob inside the wrapper. The phone showed it
  // verbatim — braces, quotes and \n escapes across half a screen (device report)
  it("shows the part of an agent-teams notification that was written for a person", () => {
    const result = "レビューを完了し、team-lead へ結果（Approved）を送信しました。\n\n要点:\n- 5 ファイルとも反映";
    writeJsonl(file, [{
      type: "user", uuid: "u1",
      message: { role: "user", content:
        "Another Claude session sent a message:\n<teammate-message teammate_id=\"review-b2\" color=\"blue\">\n"
        + JSON.stringify({ type: "idle_notification", from: "review-b2", timestamp: "2026-08-31T14:23:47.220Z", idleReason: "available", result })
        + "\n</teammate-message>" + FOOTER },
    }]);
    expect(readTranscript(file).events).toEqual([{
      type: "peer_message",
      payload: { from: "review-b2", summary: "Went idle", text: result },
    }]);
  });

  it("says what happened when a notification carries nothing written for a person", () => {
    writeJsonl(file, [{
      type: "user", uuid: "u1",
      message: { role: "user", content:
        "Another Claude session sent a message:\n<teammate-message teammate_id=\"verify-f11\">\n"
        + JSON.stringify({ type: "idle_notification", from: "verify-f11", idleReason: "available" })
        + "\n</teammate-message>" + FOOTER },
    }]);
    expect(readTranscript(file).events).toEqual([{
      type: "peer_message",
      payload: { from: "verify-f11", text: "Went idle (available)" },
    }]);
  });

  // An unknown payload must stay complete — just readable instead of one endless line
  it("lays out a JSON payload it does not recognise instead of printing it on one line", () => {
    writeJsonl(file, [{
      type: "user", uuid: "u1",
      message: { role: "user", content:
        "<cross-session-message from-name=\"planner\">\n" + JSON.stringify({ type: "handover", tasks: ["a", "b"] })
        + "\n</cross-session-message>" },
    }]);
    const payload = readTranscript(file).events[0]!.payload as { summary?: string; text: string };
    expect(payload.summary).toBe("handover");
    expect(payload.text).toBe(JSON.stringify({ type: "handover", tasks: ["a", "b"] }, null, 2));
  });

  // The sender's own summary attribute is the one written by hand; it wins over ours
  it("keeps the wrapper's summary when the body is a notification too", () => {
    writeJsonl(file, [{
      type: "user", uuid: "u1",
      message: { role: "user", content:
        "<teammate-message teammate_id=\"b2\" summary=\"Review approved\">\n"
        + JSON.stringify({ type: "idle_notification", result: "done" }) + "\n</teammate-message>" },
    }]);
    expect(readTranscript(file).events[0]!.payload).toEqual({ from: "b2", summary: "Review approved", text: "done" });
  });

  it("leaves a body that merely starts with a brace alone", () => {
    writeJsonl(file, [{
      type: "user", uuid: "u1",
      message: { role: "user", content:
        "<teammate-message teammate_id=\"b2\">\n{not json, just text}\n</teammate-message>" },
    }]);
    expect(readTranscript(file).events[0]!.payload.text).toBe("{not json, just text}");
  });

  it("does not mistake a person mentioning a tag for a peer message", () => {
    writeJsonl(file, [{
      type: "user", uuid: "u1",
      message: { role: "user", content: "why does tiny show <teammate-message> raw?" },
    }]);
    expect(readTranscript(file).events).toEqual([{ type: "user_message", payload: { text: "why does tiny show <teammate-message> raw?" } }]);
  });

  // `/model` and its kin are recorded as a `<command-name>` record followed by a
  // `<local-command-stdout>` record. The first is what the person typed; the second is
  // Claude Code's own output for the terminal
  it("shows a slash command as what was typed and drops its local output", () => {
    writeJsonl(file, [
      { type: "user", uuid: "u1", message: { role: "user", content: "<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>" } },
      { type: "user", uuid: "u2", message: { role: "user", content: "<local-command-stdout>Kept model as Fable 5</local-command-stdout>" } },
      { type: "user", uuid: "u3", message: { role: "user", content: "<command-name>/loop</command-name>\n<command-message>loop</command-message>\n<command-args>5m /foo</command-args>" } },
      { type: "user", uuid: "u4", message: { role: "user", content: "<command-message>handoff</command-message>\n<command-name>/handoff</command-name>" } },
    ]);
    expect(readTranscript(file).events).toEqual([
      { type: "user_message", payload: { text: "/model" } },
      { type: "user_message", payload: { text: "/loop 5m /foo" } },
      { type: "user_message", payload: { text: "/handoff" } },
    ]);
  });

  // Subagent completion notices are harness input (promptSource "system"), never something the person said
  it("drops task-notification records", () => {
    writeJsonl(file, [
      { type: "user", uuid: "u1", promptSource: "system", origin: { kind: "task-notification" },
        message: { role: "user", content: "<task-notification>\n<task-id>x</task-id>\n<status>completed</status>\n</task-notification>" } },
      { type: "user", uuid: "u2", message: { role: "user", content: "and then the person spoke" } },
    ]);
    const r = readTranscript(file);
    expect(r.events).toEqual([{ type: "user_message", payload: { text: "and then the person spoke" } }]);
  });

  it("neither counts peer and command records as human turns nor titles a session with them", () => {
    writeJsonl(file, [
      { type: "user", uuid: "u0", message: { role: "user", content: "<command-name>/model</command-name>" } },
      { type: "user", uuid: "u1", message: { role: "user", content: "Another Claude session sent a message:\n<teammate-message teammate_id=\"t\">\nhi\n</teammate-message>" + FOOTER } },
      { type: "user", uuid: "u2", message: { role: "user", content: "the real question" } },
      { type: "user", uuid: "u3", message: { role: "user", content: "<command-name>/cost</command-name>" } },
    ]);
    const r = readTranscript(file, { turns: 1 });
    expect(r.title).toBe("the real question");
    // one human turn = from "the real question" onward
    expect(r.events.map((e) => e.type)).toEqual(["user_message", "user_message"]);
    expect(r.events[0]!.payload.text).toBe("the real question");
  });
});

describe("claude-transcript thinking and turn progress", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-tr-"));
  });

  const human = (uuid: string, text: string, timestamp: string): Record<string, unknown> => ({
    type: "user", uuid, timestamp, message: { role: "user", content: text },
  });
  const assistant = (
    uuid: string,
    id: string,
    content: Array<Record<string, unknown>>,
    outputTokens: number,
  ): Record<string, unknown> => ({
    type: "assistant", uuid, message: { id, content, usage: { input_tokens: 2, output_tokens: outputTokens } },
  });

  it("imports a thinking block with a body as assistant_thinking and drops an empty one", () => {
    const file = path.join(root, "projects", "p", `${SID}.jsonl`);
    writeJsonl(file, [
      human("u1", "go", "2026-08-31T12:06:55.000Z"),
      assistant("a1", "msg_1", [{ type: "thinking", thinking: "", signature: "x" }], 10),
      assistant("a2", "msg_1", [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a" } }], 10),
      assistant("a3", "msg_2", [{ type: "thinking", thinking: "Checked the hedge; now the timeouts.", signature: "y" }], 5),
      assistant("a4", "msg_2", [{ type: "text", text: "Done." }], 5),
    ]);
    const read = readTranscript(file);
    expect(read.events.map((e) => e.type)).toEqual(["user_message", "tool_started", "assistant_thinking", "assistant_text"]);
    expect(read.events[2]!.payload).toEqual({ text: "Checked the hedge; now the timeouts." });
  });

  it("sums the newest turn's output tokens once per API response, from the record that started it", () => {
    const messages = [
      human("u1", "first question", "2026-08-31T12:00:00.000Z"),
      assistant("a1", "msg_old", [{ type: "text", text: "old answer" }], 999),
      human("u2", "second question", "2026-08-31T12:06:55.000Z"),
      // Claude Code repeats one response's usage on each of its records: thinking / text / tool_use
      assistant("a2", "msg_1", [{ type: "thinking", thinking: "" }], 363),
      assistant("a3", "msg_1", [{ type: "text", text: "Looking" }], 363),
      assistant("a4", "msg_1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }], 363),
      { type: "user", uuid: "u3", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1" }] } },
      // A subagent notice lands mid-turn as a user record; it must not restart the count
      { type: "user", uuid: "u4", timestamp: "2026-08-31T12:07:00.000Z", message: { role: "user", content: "<task-notification>done</task-notification>" } },
      assistant("a5", "msg_2", [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "pwd" } }], 234),
    ];
    expect(newestTurn(messages)).toEqual({ startedAt: "2026-08-31T12:06:55.000Z", outputTokens: 597 });
  });

  it("treats a message injected through the messaging socket as the start of a turn", () => {
    const messages = [
      human("u1", "typed in the terminal", "2026-08-31T12:00:00.000Z"),
      assistant("a1", "msg_old", [{ type: "text", text: "terminal answer" }], 100),
      {
        type: "user", uuid: "p1", isMeta: true, timestamp: "2026-08-31T12:10:00.000Z",
        origin: { kind: "peer", msg_id: "m-1", name: "tiny" },
        message: { role: "user", content: "Another Claude session sent a message: hi" },
      },
      assistant("a2", "msg_new", [{ type: "text", text: "phone answer" }], 40),
    ];
    expect(newestTurn(messages)).toEqual({ startedAt: "2026-08-31T12:10:00.000Z", outputTokens: 40 });
  });

  it("is null before the first turn, and reports zero tokens right after a prompt", () => {
    expect(newestTurn([])).toBeNull();
    expect(newestTurn([{ type: "user", uuid: "m", isMeta: true, message: { role: "user", content: "<local-command-caveat>x</local-command-caveat>" } }])).toBeNull();
    const file = path.join(root, "projects", "p", `${SID}.jsonl`);
    writeJsonl(file, [human("u1", "go", "2026-08-31T12:06:55.000Z")]);
    expect(readTranscript(file).turn).toEqual({ startedAt: "2026-08-31T12:06:55.000Z", outputTokens: 0 });
  });
});

// AskUserQuestion in a CLI-owned session. Nobody on the phone can answer it (the messaging socket
// takes messages, not tool results), but the question and the chosen answer are conversation and
// have to reach the phone — as a read-only question card, then as a question+answer card
describe("claude-transcript AskUserQuestion", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-trq-"));
  });

  const QUESTION_INPUT = {
    questions: [{
      question: "Which goal?",
      header: "Goal",
      multiSelect: false,
      options: [{ label: "staging", description: "up to staging" }, { label: "production", description: "all the way" }],
    }],
  };

  function ask(uuid: string, id: string): Record<string, unknown> {
    return {
      type: "assistant", uuid,
      message: { content: [{ type: "tool_use", id, name: "AskUserQuestion", input: QUESTION_INPUT }] },
    };
  }

  it("emits cli_question instead of tool_started for the question", () => {
    const file = path.join(root, "projects", "-srv-a-x", `${SID}.jsonl`);
    writeJsonl(file, [ask("a1", "t1")]);
    const r = readTranscript(file);
    expect(r.events.map((e) => e.type)).toEqual(["cli_question"]);
    expect(r.events[0]!.payload).toEqual({ toolUseId: "t1", input: QUESTION_INPUT });
  });

  it("emits cli_question_answered with the answers keyed by question text", () => {
    const file = path.join(root, "projects", "-srv-a-x", `${SID}.jsonl`);
    writeJsonl(file, [
      ask("a1", "t1"),
      {
        type: "user", uuid: "u1",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Your questions have been answered" }] },
        toolUseResult: { questions: QUESTION_INPUT.questions, answers: { "Which goal?": "staging" }, annotations: {} },
      },
    ]);
    const r = readTranscript(file);
    expect(r.events.map((e) => e.type)).toEqual(["cli_question", "cli_question_answered"]);
    expect(r.events[1]!.payload).toEqual({ toolUseId: "t1", answers: { "Which goal?": "staging" } });
  });

  it("recognises the answers even when the question fell outside this read", () => {
    const file = path.join(root, "projects", "-srv-a-x", `${SID}.jsonl`);
    writeJsonl(file, [
      ask("a1", "t1"),
      {
        type: "user", uuid: "u1",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1" }] },
        toolUseResult: { questions: QUESTION_INPUT.questions, answers: { "Which goal?": "production" } },
      },
    ]);
    const r = readTranscript(file, { sinceUuid: "a1" });
    expect(r.events.map((e) => e.type)).toEqual(["cli_question_answered"]);
    expect(r.events[0]!.payload).toEqual({ toolUseId: "t1", answers: { "Which goal?": "production" } });
  });

  it("closes the card as rejected when the question was dismissed in the CLI", () => {
    const file = path.join(root, "projects", "-srv-a-x", `${SID}.jsonl`);
    writeJsonl(file, [
      ask("a1", "t1"),
      {
        type: "user", uuid: "u1",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "The user doesn't want to proceed with this tool use." }],
        },
        toolUseResult: "User rejected tool use",
      },
    ]);
    const r = readTranscript(file);
    expect(r.events.map((e) => e.type)).toEqual(["cli_question", "cli_question_answered"]);
    expect(r.events[1]!.payload).toEqual({ toolUseId: "t1", answers: {}, rejected: true });
  });

  it("closes a question from an earlier read when openQuestions names it", () => {
    const file = path.join(root, "projects", "-srv-a-x", `${SID}.jsonl`);
    writeJsonl(file, [
      ask("a1", "t1"),
      {
        type: "user", uuid: "u1",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: true }] },
        toolUseResult: "User rejected tool use",
      },
    ]);
    // The question was imported before this read, so only the caller still knows the id
    const r = readTranscript(file, { sinceUuid: "a1", openQuestions: ["t1"] });
    expect(r.events.map((e) => e.type)).toEqual(["cli_question_answered"]);
    expect(r.events[0]!.payload).toEqual({ toolUseId: "t1", answers: {}, rejected: true });
  });

  it("leaves ordinary tool results alone", () => {
    const file = path.join(root, "projects", "-srv-a-x", `${SID}.jsonl`);
    writeJsonl(file, [
      {
        type: "assistant", uuid: "a1",
        message: { content: [{ type: "tool_use", id: "t9", name: "Read", input: { file_path: "/tmp/x" } }] },
      },
      {
        type: "user", uuid: "u1",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t9", is_error: false }] },
        toolUseResult: { type: "text", file: { filePath: "/tmp/x" } },
      },
    ]);
    const r = readTranscript(file);
    expect(r.events.map((e) => e.type)).toEqual(["tool_started", "tool_finished"]);
  });
});
