import { describe, expect, it } from "vitest";
import { TOOL_OUTPUT_LIMIT, clipToolOutput, toolOutputPayload, toolOutputText } from "../src/tool-output.js";

describe("tool-output", () => {
  it("takes a content string as-is and treats blank as nothing", () => {
    expect(toolOutputText("hello\nworld")).toBe("hello\nworld");
    expect(toolOutputText("   \n")).toBeNull();
    expect(toolOutputText(undefined)).toBeNull();
    expect(toolOutputText(42)).toBeNull();
  });

  it("joins the text blocks of a content array and ignores the rest", () => {
    expect(toolOutputText([{ type: "text", text: "a" }, { type: "image", source: {} }, { type: "text", text: "b" }])).toBe("a\nb");
    expect(toolOutputText([{ type: "image", source: {} }])).toBeNull();
  });

  it("combines stdout and stderr the way a terminal shows them", () => {
    expect(toolOutputText({ stdout: "ok", stderr: "" })).toBe("ok");
    expect(toolOutputText({ stdout: "", stderr: "boom" })).toBe("boom");
    expect(toolOutputText({ stdout: "ok", stderr: "warn" })).toBe("ok\nwarn");
    expect(toolOutputText({ stdout: "", stderr: "" })).toBeNull();
  });

  it("reads {output} and MCP-style {content: [...]} results", () => {
    expect(toolOutputText({ output: "done" })).toBe("done");
    expect(toolOutputText({ content: [{ type: "text", text: "sent" }] })).toBe("sent");
    expect(toolOutputText({ status: "ok" })).toBeNull();
  });

  it("keeps the head of a long output and says so", () => {
    const long = "x".repeat(TOOL_OUTPUT_LIMIT + 5);
    expect(clipToolOutput(long)).toEqual({ output: "x".repeat(TOOL_OUTPUT_LIMIT), truncated: true });
    expect(clipToolOutput("short")).toEqual({ output: "short" });
    expect(toolOutputPayload(long)).toMatchObject({ truncated: true });
    expect(toolOutputPayload("")).toEqual({});
  });
});
