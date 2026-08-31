import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTinyMcpServer } from "../src/mcp-server.js";

// The guts of tiny mcp-server (stdio). Agents (Claude / ACP family) launch this as an MCP server
// and its send_user_file tool hits tinyd's POST /v1/sessions/:id/files
async function connect(fetchImpl: typeof fetch) {
  const server = createTinyMcpServer({
    serverUrl: "http://127.0.0.1:7777",
    token: "cli-secret",
    sessionId: "sess-1",
    fetchImpl,
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  return { client, server };
}

describe("tiny mcp-server", () => {
  it("exposes the send_user_file tool, forwards to tinyd's files API, and returns the fileId", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ fileId: "f-42", mime: "text/html" }), { status: 201 });
    }) as unknown as typeof fetch;
    const { client } = await connect(fetchImpl);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(["send_user_file"]);

    const out = await client.callTool({ name: "send_user_file", arguments: { path: "/tmp/r.html", caption: "report" } });
    expect(out.isError ?? false).toBe(false);
    expect(JSON.stringify(out.content)).toContain("f-42");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:7777/v1/sessions/sess-1/files");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer cli-secret");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ path: "/tmp/r.html", caption: "report" });
  });

  it("marks the tool result isError with the reason when tinyd errors (the agent can rephrase)", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "ENOENT: no such file" }), { status: 404 })) as unknown as typeof fetch;
    const { client } = await connect(fetchImpl);
    const out = await client.callTool({ name: "send_user_file", arguments: { path: "/tmp/missing.html" } });
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out.content)).toContain("no such file");
  });

  it("rejects relative paths (unresolvable since the cwd differs)", async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return new Response("{}", { status: 201 }); }) as unknown as typeof fetch;
    const { client } = await connect(fetchImpl);
    const out = await client.callTool({ name: "send_user_file", arguments: { path: "report.html" } });
    expect(out.isError).toBe(true);
    expect(called).toBe(false);
  });
});
