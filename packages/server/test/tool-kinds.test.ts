import { describe, expect, it } from "vitest";
import { describeClaudeTool } from "../src/tool-kinds.js";

// kind is the ACP ToolKind vocabulary (read / edit / delete / move / search / execute / think / fetch / other)
// plus tiny's own question. iOS (Phase A) decides a row's look from this vocabulary
describe("describeClaudeTool", () => {
  it("Bash is execute; the summary is description, or command when absent", () => {
    expect(describeClaudeTool("Bash", { command: "ls -la", description: "List files" }))
      .toEqual({ kind: "execute", summary: "List files" });
    expect(describeClaudeTool("Bash", { command: "ls -la" })).toEqual({ kind: "execute", summary: "ls -la" });
  });

  it("edit-like tools are edit with the file name as the summary", () => {
    for (const name of ["Edit", "Write", "MultiEdit"]) {
      expect(describeClaudeTool(name, { file_path: "/a/b/ChatView.swift" })).toEqual({ kind: "edit", summary: "ChatView.swift" });
    }
    expect(describeClaudeTool("NotebookEdit", { notebook_path: "/n/x.ipynb" })).toEqual({ kind: "edit", summary: "x.ipynb" });
  });

  it("Read is read; Grep / Glob are search (the summary is the pattern)", () => {
    expect(describeClaudeTool("Read", { file_path: "/a/x.md" })).toEqual({ kind: "read", summary: "x.md" });
    expect(describeClaudeTool("Grep", { pattern: "TODO", path: "/a" })).toEqual({ kind: "search", summary: "TODO" });
    expect(describeClaudeTool("Glob", { pattern: "**/*.ts" })).toEqual({ kind: "search", summary: "**/*.ts" });
  });

  it("WebFetch / WebSearch are fetch", () => {
    expect(describeClaudeTool("WebFetch", { url: "https://x.example/a" })).toEqual({ kind: "fetch", summary: "https://x.example/a" });
    expect(describeClaudeTool("WebSearch", { query: "acp protocol" })).toEqual({ kind: "fetch", summary: "acp protocol" });
  });

  it("AskUserQuestion is question with the first question as the summary", () => {
    expect(describeClaudeTool("AskUserQuestion", { questions: [{ question: "Which color?", options: [] }] }))
      .toEqual({ kind: "question", summary: "Which color?" });
    expect(describeClaudeTool("AskUserQuestion", {})).toEqual({ kind: "question", summary: "Question" });
  });

  it("send_user_file is other with Sent: filename; TodoWrite is think; unknown is other with the tool name", () => {
    expect(describeClaudeTool("mcp__tiny__send_user_file", { path: "/tmp/report.html" }))
      .toEqual({ kind: "other", summary: "Sent: report.html" });
    expect(describeClaudeTool("TodoWrite", { todos: [] })).toEqual({ kind: "think", summary: "Updated plan" });
    expect(describeClaudeTool("Task", { description: "Explore repo" })).toEqual({ kind: "other", summary: "Explore repo" });
    expect(describeClaudeTool("SomethingNew", { x: 1 })).toEqual({ kind: "other", summary: "SomethingNew" });
  });

  it("the summary is one line and gets trimmed when too long", () => {
    const long = "a".repeat(300) + "\nsecond line";
    const { summary } = describeClaudeTool("Bash", { command: long });
    expect(summary.includes("\n")).toBe(false);
    expect(summary.length).toBeLessThanOrEqual(120);
  });
});
