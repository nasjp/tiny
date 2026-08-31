import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// `tiny mcp-server` (stdio). Agents (Claude's SDK / ACP family / Codex) launch this as an MCP server
// and send deliverables to the iPhone via the send_user_file tool. Internally it just calls tinyd's
// POST /v1/sessions/:id/files. Which session it belongs to comes from env at launch time
// (Claude SDK's mcpServers.env / ACP's session/new.mcpServers[].env / Codex's config).

export interface TinyMcpServerOptions {
  serverUrl: string;
  token: string;
  sessionId: string;
  fetchImpl?: typeof fetch;
}

export function createTinyMcpServer(opts: TinyMcpServerOptions): McpServer {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const server = new McpServer({ name: "tiny", version: "1" });
  server.registerTool(
    "send_user_file",
    {
      description:
        "Send a file to the user's iPhone and display it. Call this when you have a deliverable the user should see, such as an HTML report or an image. Use an absolute path.",
      inputSchema: {
        path: z.string().describe("absolute path of the file to send"),
        caption: z.string().optional().describe("one-line description"),
      },
    },
    async ({ path: filePath, caption }) => {
      if (!path.isAbsolute(filePath)) {
        return { isError: true, content: [{ type: "text" as const, text: `path must be absolute: ${filePath}` }] };
      }
      const res = await fetchImpl(`${opts.serverUrl}/v1/sessions/${opts.sessionId}/files`, {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath, ...(caption === undefined ? {} : { caption }) }),
      });
      const text = await res.text();
      if (!res.ok) {
        let reason = text;
        try {
          const j = JSON.parse(text) as { error?: unknown };
          if (typeof j.error === "string") reason = j.error;
        } catch {
          // keep the raw text
        }
        return { isError: true, content: [{ type: "text" as const, text: `send_user_file failed (${res.status}): ${reason}` }] };
      }
      const { fileId } = JSON.parse(text) as { fileId: string };
      return { content: [{ type: "text" as const, text: `Sent to the user (fileId: ${fileId})` }] };
    },
  );
  return server;
}

/** Entry point of `tiny mcp-server`. Connection info comes from env (TINY_SERVER_URL / TINY_TOKEN / TINY_SESSION_ID) */
export async function runTinyMcpServer(env: Record<string, string | undefined> = process.env): Promise<void> {
  const serverUrl = env.TINY_SERVER_URL;
  const token = env.TINY_TOKEN;
  const sessionId = env.TINY_SESSION_ID;
  if (!serverUrl || !token || !sessionId) {
    throw new Error("tiny mcp-server needs TINY_SERVER_URL, TINY_TOKEN and TINY_SESSION_ID (tinyd sets them)");
  }
  const server = createTinyMcpServer({ serverUrl, token, sessionId });
  await server.connect(new StdioServerTransport());
}
