import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findTranscript, readTranscript } from "../src/claude-transcript.js";

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
    const cwd = "/Users/a/ghq/github.com/x";
    const file = path.join(root, "projects", "-Users-a-ghq-github-com-x", `${SID}.jsonl`);
    writeJsonl(file, sample());
    expect(findTranscript(root, cwd, SID)).toBe(file);
  });

  it("falls back to scanning projects/ when the encoding does not match", () => {
    const file = path.join(root, "projects", "some-other-name", `${SID}.jsonl`);
    writeJsonl(file, sample());
    expect(findTranscript(root, "/Users/a/whatever", SID)).toBe(file);
  });

  it("returns null when there is no transcript", () => {
    expect(findTranscript(root, "/Users/a/x", SID)).toBeNull();
  });

  it("converts user, assistant text and tool records into events", () => {
    const file = path.join(root, "projects", "-Users-a-x", `${SID}.jsonl`);
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
    const file = path.join(root, "projects", "-Users-a-x", `${SID}.jsonl`);
    writeJsonl(file, sample());
    const r = readTranscript(file, { sinceUuid: "a1" });
    expect(r.events.map((e) => e.type)).toEqual(["tool_finished"]);
    expect(r.cursor).toBe("u2");
  });

  it("keeps only the last `limit` message records on a first read", () => {
    const many: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 10; i++) {
      many.push({ type: "user", uuid: `u${i}`, message: { role: "user", content: `m${i}` } });
    }
    const file = path.join(root, "projects", "-Users-a-x", `${SID}.jsonl`);
    writeJsonl(file, many);
    const r = readTranscript(file, { limit: 3 });
    expect(r.events).toHaveLength(3);
    expect(r.events[0]!.payload.text).toBe("m7");
    expect(r.cursor).toBe("u9");
  });

  it("survives malformed lines and unknown record types", () => {
    const file = path.join(root, "projects", "-Users-a-x", `${SID}.jsonl`);
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
    const file = path.join(root, "projects", "-Users-a-x", `${SID}.jsonl`);
    writeJsonl(file, [
      { type: "user", uuid: "u1", message: { role: "user", content: "a".repeat(100) } },
    ]);
    expect(readTranscript(file).title).toHaveLength(60);
  });

  it("classifies tool calls the same way the live adapter does", () => {
    const file = path.join(root, "projects", "-Users-a-x", `${SID}.jsonl`);
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
    const file = path.join(root, "projects", "-Users-a-x", `${SID}.jsonl`);
    writeJsonl(file, sample());
    // a cursor from a transcript that was forked or rotated away
    const r = readTranscript(file, { sinceUuid: "gone-forever" });
    expect(r.events).toEqual([]);
    // the cursor still advances so the next sync resumes correctly
    expect(r.cursor).toBe("u2");
  });
});
