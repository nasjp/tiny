#!/usr/bin/env node
// Empirical probe against the codex app-server (JSON-RPC/stdio). Same skeleton as scripts/acp-probe.mjs.
// Usage: node scripts/codex-probe.mjs all
//        node scripts/codex-probe.mjs resume <threadId>
// Env vars: CODEX_HOME (required; an isolated dir containing only auth.json) / CODEX_CWD (default $TMPDIR/codex-probe-work; must be git init'ed)
// Output: ./codex-probe-<mode>.json (summary) and ./codex-probe-<mode>.log (full transcript)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const mode = process.argv[2] ?? "all";
const givenThreadId = process.argv[3];
const CODEX_HOME = process.env.CODEX_HOME;
if (!CODEX_HOME) {
  console.error("Set CODEX_HOME (an isolated directory containing only a copy of auth.json)");
  process.exit(1);
}
const WORK = process.env.CODEX_CWD ?? path.join(os.tmpdir(), "codex-probe-work");
fs.mkdirSync(WORK, { recursive: true });
const logFile = path.resolve(`codex-probe-${mode}.log`);
fs.writeFileSync(logFile, "");
const log = (dir, line) => fs.appendFileSync(logFile, `${new Date().toISOString()} ${dir} ${line}\n`);

const env = { ...process.env, CODEX_HOME };
delete env.OPENAI_API_KEY;
delete env.CODEX_API_KEY;
delete env.ANTHROPIC_API_KEY;
const child = spawn("codex", ["app-server"], { cwd: WORK, env, stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (d) => log("ERR", String(d).trimEnd()));
child.on("exit", (code, sig) => log("EXIT", `code=${code} sig=${sig}`));

let nextId = 1;
const pending = new Map();
const notifications = []; // { method, params }
const requestsFromServer = []; // method names the server sent us as requests
const send = (msg) => { const line = JSON.stringify(msg); log("->", line); child.stdin.write(line + "\n"); };
const request = (method, params) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); send({ jsonrpc: "2.0", id, method, params }); });
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

// Response policy for server requests (probe defaults): accept approvals; answer "red" to requestUserInput.
function handleServerRequest(msg) {
  requestsFromServer.push(msg.method);
  approvalLog.push({ method: msg.method, params: msg.params });
  if (msg.method === "item/commandExecution/requestApproval") {
    send({ jsonrpc: "2.0", id: msg.id, result: { decision: "accept" } });
  } else if (msg.method === "item/fileChange/requestApproval") {
    send({ jsonrpc: "2.0", id: msg.id, result: { decision: "accept" } });
  } else if (msg.method === "item/tool/requestUserInput") {
    const answers = {};
    for (const q of msg.params.questions ?? []) answers[q.id] = { answers: ["red"] };
    send({ jsonrpc: "2.0", id: msg.id, result: { answers } });
  } else {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `probe does not implement ${msg.method}` } });
  }
}

const approvalLog = [];
readline.createInterface({ input: child.stdout }).on("line", (line) => {
  log("<-", line);
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined && msg.method === undefined) {
    if (!pending.has(msg.id)) return;
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    return;
  }
  if (msg.id !== undefined && msg.method) { handleServerRequest(msg); return; }
  if (msg.method) notifications.push({ method: msg.method, params: msg.params });
});

const since = (from) => notifications.slice(from);
const methodsSince = (from) => since(from).map((n) => n.method);
const itemsShape = (from) =>
  since(from)
    .filter((n) => n.method === "item/started" || n.method === "item/completed")
    .map((n) => ({
      m: n.method,
      type: n.params?.item?.item_type ?? n.params?.item?.type,
      id: n.params?.item?.id,
      status: n.params?.item?.status,
      command: n.params?.item?.command,
      cwd: n.params?.item?.cwd,
      text: n.params?.item?.text,
    }));
const tokenUsageSince = (from) => since(from).filter((n) => n.method === "thread/tokenUsage/updated").map((n) => n.params);
const turnCompleted = (from) => since(from).find((n) => n.method === "turn/completed")?.params;
const RED_PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAgMAAAAl21bKAAAAAxQTFRF/wAA////AAAA////pdmf3QAAAAJ0Uk5T/wDltzBKAAAAD0lEQVR4nGNgAAJGKAMDAAA2AAHOVE5tAAAAAElFTkSuQmCC";

async function waitForTurnCompleted(fromIdx, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const c = turnCompleted(fromIdx);
    if (c) return c;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`turn/completed timeout after ${timeoutMs}ms`);
}

const out = { mode, codexHome: CODEX_HOME, cwd: WORK };

async function runAll() {
  // 1. initialize
  const t0 = Date.now();
  out.initialize = { result: await request("initialize", { clientInfo: { name: "tiny-probe", title: "tiny", version: "0" } }), ms: Date.now() - t0 };
  // Is the initialized notification required? Try thread/start without sending it first
  const from1 = notifications.length;
  let threadStartWorkedWithoutInitialized = true;
  let threadStartError = null;
  let threadStartResult = null;
  try {
    threadStartResult = await request("thread/start", { cwd: WORK, approvalPolicy: "on-request", sandbox: "workspace-write" });
  } catch (e) {
    threadStartWorkedWithoutInitialized = false;
    threadStartError = String(e);
  }
  out.initializedNotificationNeeded = { threadStartWorkedWithoutInitialized, threadStartError };

  // Send the initialized notification anyway (for compatibility with what follows)
  notify("initialized", {});

  let threadId;
  if (threadStartResult) {
    threadId = threadStartResult.thread?.id ?? threadStartResult.threadId;
    out.threadStart = { result: threadStartResult };
  } else {
    const t1 = Date.now();
    const r = await request("thread/start", { cwd: WORK, approvalPolicy: "on-request", sandbox: "workspace-write" });
    threadId = r.thread?.id ?? r.threadId;
    out.threadStart = { result: r, ms: Date.now() - t1 };
  }
  out.threadId = threadId;
  fs.writeFileSync(path.resolve("codex-probe-threadid.txt"), threadId ?? "");

  // 2. turn/start (command execution + approval)
  {
    const from = notifications.length;
    const t1 = Date.now();
    const resp = await request("turn/start", {
      threadId,
      input: [{ type: "text", text: "Run exactly: echo codex-probe-ok . Then reply with only: done" }],
      cwd: WORK,
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "workspaceWrite" },
    });
    const completed = await waitForTurnCompleted(from);
    out.turnEcho = {
      startResponse: resp,
      ms: Date.now() - t1,
      notifications: methodsSince(from),
      items: itemsShape(from),
      tokenUsage: tokenUsageSince(from),
      turnCompleted: completed,
      approvalsSeen: approvalLog.filter((a) => a.method === "item/commandExecution/requestApproval"),
    };
  }

  // 3. account/rateLimits/read
  {
    const t1 = Date.now();
    try {
      out.rateLimits = { result: await request("account/rateLimits/read", {}), ms: Date.now() - t1 };
    } catch (e) {
      out.rateLimits = { error: String(e) };
    }
  }

  // 4. image
  {
    const from = notifications.length;
    const t1 = Date.now();
    try {
      const resp = await request("turn/start", {
        threadId,
        input: [
          { type: "image", url: `data:image/png;base64,${RED_PNG_1X1}` },
          { type: "text", text: "What color is this 1x1 image? One word." },
        ],
        cwd: WORK,
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "workspaceWrite" },
      });
      const completed = await waitForTurnCompleted(from);
      out.turnImage = { startResponse: resp, ms: Date.now() - t1, items: itemsShape(from), turnCompleted: completed };
    } catch (e) {
      out.turnImage = { error: String(e) };
    }
  }

  // 5. interrupt
  {
    const from = notifications.length;
    const t1 = Date.now();
    const p = request("turn/start", {
      threadId,
      input: [{ type: "text", text: "Count from 1 to 300, one number per line, no other text." }],
      cwd: WORK,
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "workspaceWrite" },
    });
    const startResp = await p; // wait for the turn/start response (contains turn.id)
    const turnId = startResp.turn?.id ?? startResp.turnId;
    // wait for the first agentMessage/delta or 3 seconds
    const waitDeltaOrTimeout = async () => {
      const t = Date.now();
      while (Date.now() - t < 3000) {
        if (since(from).some((n) => n.method === "item/agentMessage/delta")) return;
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    await waitDeltaOrTimeout();
    const tInterrupt = Date.now();
    await request("turn/interrupt", { threadId, turnId });
    const completed = await waitForTurnCompleted(from, 30000);
    out.turnInterrupt = {
      startResponse: startResp,
      msToInterrupt: tInterrupt - t1,
      msInterruptToCompleted: Date.now() - tInterrupt,
      turnCompleted: completed,
    };
  }

  // 6. requestUserInput
  {
    const from = notifications.length;
    const t1 = Date.now();
    try {
      const resp = await request("turn/start", {
        threadId,
        input: [{ type: "text", text: "Ask me which color I prefer, red or blue, using your request_user_input tool, then reply with my choice." }],
        cwd: WORK,
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "workspaceWrite" },
      });
      const completed = await waitForTurnCompleted(from, 60000);
      out.turnUserInput = {
        startResponse: resp,
        ms: Date.now() - t1,
        items: itemsShape(from),
        turnCompleted: completed,
        requestUserInputSeen: approvalLog.filter((a) => a.method === "item/tool/requestUserInput"),
      };
    } catch (e) {
      out.turnUserInput = { error: String(e), items: itemsShape(from) };
    }
  }

  // 9. MCP (try via config in thread/start; if that fails, verify the config.toml fallback outside this script)
  {
    const mcpEnv = {
      TINY_SERVER_URL: "http://127.0.0.1:7777",
      TINY_TOKEN: (() => { try { return fs.readFileSync(path.join(os.homedir(), ".tiny", "secret"), "utf8").trim(); } catch { return "dummy"; } })(),
      TINY_SESSION_ID: "probe-session",
    };
    const repoRoot = path.resolve(new URL(import.meta.url).pathname, "..", "..");
    const tsxCli = path.join(repoRoot, "packages", "server", "node_modules", "tsx", "dist", "cli.mjs");
    const serverCli = path.join(repoRoot, "packages", "server", "src", "cli.ts");
    try {
      const t1 = Date.now();
      const r2 = await request("thread/start", {
        cwd: WORK,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        config: { mcp_servers: { tiny: { command: process.execPath, args: [tsxCli, serverCli, "mcp-server"], env: mcpEnv } } },
      });
      const mcpThreadId = r2.thread?.id ?? r2.threadId;
      const from = notifications.length;
      const listResp = await request("mcpServerStatus/list", {}).catch((e) => ({ error: String(e) }));
      const turnResp = await request("turn/start", {
        threadId: mcpThreadId,
        input: [{ type: "text", text: "List the MCP tools you have available. Just list their names, one per line." }],
        cwd: WORK,
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "workspaceWrite" },
      }).catch((e) => ({ error: String(e) }));
      let completed = null;
      try { completed = await waitForTurnCompleted(from, 30000); } catch (e) { completed = { error: String(e) }; }
      out.mcpViaThreadStartConfig = { ms: Date.now() - t1, threadStartResult: r2, mcpServerStatusList: listResp, turnStartResult: turnResp, items: itemsShape(from), turnCompleted: completed };
    } catch (e) {
      out.mcpViaThreadStartConfig = { error: String(e) };
    }
  }

  out.requestsFromServer = [...new Set(requestsFromServer)];
  out.allNotificationMethods = [...new Set(notifications.map((n) => n.method))];
}

async function runResume() {
  const threadId = givenThreadId ?? fs.readFileSync(path.resolve("codex-probe-threadid.txt"), "utf8").trim();
  const t0 = Date.now();
  out.initialize = await request("initialize", { clientInfo: { name: "tiny-probe", title: "tiny", version: "0" } });
  notify("initialized", {});
  const t1 = Date.now();
  const resumeResult = await request("thread/resume", { threadId, cwd: WORK, approvalPolicy: "on-request", sandbox: "workspace-write" });
  out.resume = { result: resumeResult, ms: Date.now() - t1 };
  const resumedThreadId = resumeResult.thread?.id ?? resumeResult.threadId ?? threadId;
  const from = notifications.length;
  const t2 = Date.now();
  const resp = await request("turn/start", {
    threadId: resumedThreadId,
    input: [{ type: "text", text: "What exact shell command did I ask you to run earlier? Reply with just the command." }],
    cwd: WORK,
    approvalPolicy: "on-request",
    sandboxPolicy: { type: "workspaceWrite" },
  });
  const completed = await waitForTurnCompleted(from, 30000);
  out.turnAfterResume = { startResponse: resp, ms: Date.now() - t2, items: itemsShape(from), turnCompleted: completed };
  out.totalMs = Date.now() - t0;
}

try {
  if (mode === "resume") await runResume();
  else await runAll();
} catch (e) {
  out.error = String(e);
}

fs.writeFileSync(`codex-probe-${mode}.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
child.stdin.end();
setTimeout(() => { child.kill("SIGTERM"); process.exit(0); }, 1000);
