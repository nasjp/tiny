#!/usr/bin/env node
// Probe that speaks raw JSON-RPC (newline-delimited) to any ACP agent to measure real behavior.
// Usage: ACP_CMD="opencode acp" node scripts/acp-probe.mjs new
//        ACP_CMD="opencode acp" node scripts/acp-probe.mjs resume <sessionId>
//        ACP_CMD="opencode acp" node scripts/acp-probe.mjs cancel
// Env vars: ACP_CWD (working dir; default $TMPDIR/acp-probe-work) / ACP_PERMISSION=1 (use a prompt that requests permission)
//           ACP_AUTH=auto|<methodId> (if session/new says auth required, authenticate and retry)
// Output: ./acp-probe-<mode>.json (summary) and ./acp-probe-<mode>.log (full transcript)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const mode = process.argv[2] ?? "new";
const givenSession = process.argv[3];
const cmd = (process.env.ACP_CMD ?? "opencode acp").split(" ");
const WORK = process.env.ACP_CWD ?? path.join(os.tmpdir(), "acp-probe-work");
fs.mkdirSync(WORK, { recursive: true });
const logFile = path.resolve(`acp-probe-${mode}.log`);
fs.writeFileSync(logFile, "");
const log = (dir, line) => fs.appendFileSync(logFile, `${new Date().toISOString()} ${dir} ${line}\n`);

const env = { ...process.env };
delete env.ANTHROPIC_API_KEY;
const child = spawn(cmd[0], cmd.slice(1), { cwd: WORK, env, stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (d) => log("ERR", String(d).trimEnd()));
child.on("exit", (code, sig) => log("EXIT", `code=${code} sig=${sig}`));

let nextId = 1;
const pending = new Map();
const updates = [];
const requestsFromAgent = [];
const permissions = [];
const send = (msg) => { const line = JSON.stringify(msg); log("->", line); child.stdin.write(line + "\n"); };
const request = (method, params) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); send({ jsonrpc: "2.0", id, method, params }); });
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

readline.createInterface({ input: child.stdout }).on("line", (line) => {
  log("<-", line);
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined && msg.method === undefined && pending.has(msg.id)) {
    const p = pending.get(msg.id); pending.delete(msg.id);
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); return;
  }
  if (msg.method === "session/update") { updates.push(msg.params.update); return; }
  if (msg.id !== undefined && msg.method) {
    requestsFromAgent.push(msg.method);
    if (msg.method === "session/request_permission") {
      permissions.push({ toolCall: msg.params.toolCall, options: msg.params.options });
      const pick = msg.params.options.find((o) => o.kind === "allow_once") ?? msg.params.options[0];
      send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: pick.optionId } } });
    } else {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `probe does not implement ${msg.method}` } });
    }
  }
});

const kinds = (from = 0) => updates.slice(from).reduce((acc, u) => ((acc[u.sessionUpdate] = (acc[u.sessionUpdate] ?? 0) + 1), acc), {});
const textOf = (from = 0) => updates.slice(from).filter((u) => u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text").map((u) => u.content.text).join("");
const tools = (from = 0) => updates.slice(from).filter((u) => u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update").map((u) => ({ upd: u.sessionUpdate, id: u.toolCallId, kind: u.kind, title: u.title, name: u.name, status: u.status }));

const out = { mode, cmd: cmd.join(" ") };
try {
  out.initialize = await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "tiny-probe", version: "0" } });
  const caps = out.initialize.agentCapabilities ?? {};
  // Auth: ACP_AUTH=<methodId> or ACP_AUTH=auto (first entry of authMethods). If session/new etc. fails
  // with -32000 (auth required), call `authenticate { methodId }` and retry exactly once (cursor / droid needed this)
  const authId = process.env.ACP_AUTH === "auto" ? out.initialize.authMethods?.[0]?.id : process.env.ACP_AUTH;
  const withAuth = async (fn) => {
    try { return await fn(); } catch (e) {
      if (!authId || !/-32000|[Aa]uth/.test(String(e))) throw e;
      const t = Date.now();
      out.authenticate = { methodId: authId, result: await request("authenticate", { methodId: authId }), ms: Date.now() - t, after: String(e).slice(0, 160) };
      return await fn();
    }
  };
  let sessionId = givenSession;
  if (mode === "new" || mode === "cancel") {
    const t0 = Date.now();
    const r = await withAuth(() => request("session/new", { cwd: WORK, mcpServers: [] }));
    out.sessionNew = { ...r, configOptions: (r.configOptions ?? []).map((o) => ({ id: o.id, category: o.category, type: o.type, currentValue: o.currentValue, optionCount: o.options?.length })), ms: Date.now() - t0 };
    sessionId = r.sessionId;
  } else if (mode === "resume" || mode === "load") {
    const t0 = Date.now();
    const r = await withAuth(() => request(`session/${mode}`, { sessionId, cwd: WORK, mcpServers: [] }));
    out[mode] = { result: r && { configOptions: (r.configOptions ?? []).map((o) => o.id) }, replayed: kinds(), ms: Date.now() - t0 };
  }
  out.sessionId = sessionId;
  if (mode === "new") {
    const from = updates.length; const t0 = Date.now();
    const text = process.env.ACP_PERMISSION
      ? "Use your shell tool to run exactly: echo acp-probe-ok . Then reply with only the word: done"
      : "Reply with only the word: pong";
    const r = await request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
    out.prompt = { result: r, ms: Date.now() - t0, updates: kinds(from), text: textOf(from), tools: tools(from), permissions };
    if (caps.promptCapabilities?.image) {
      const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
      const f = updates.length; const t1 = Date.now();
      const r2 = await request("session/prompt", { sessionId, prompt: [{ type: "image", data: png, mimeType: "image/png" }, { type: "text", text: "What color is this 1x1 image? One word." }] }).catch((e) => ({ error: String(e) }));
      out.image = { result: r2, ms: Date.now() - t1, text: textOf(f) };
    }
  } else if (mode === "cancel") {
    const from = updates.length; const t0 = Date.now();
    const p = request("session/prompt", { sessionId, prompt: [{ type: "text", text: "Count from 1 to 300, one number per line, no other text." }] });
    await new Promise((res) => { const iv = setInterval(() => { if (updates.length > from) { clearInterval(iv); res(); } }, 50); setTimeout(() => { clearInterval(iv); res(); }, 8000); });
    const tc = Date.now();
    notify("session/cancel", { sessionId });
    const r = await Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("no response 15s after cancel")), 15000))]).catch((e) => ({ error: String(e) }));
    out.cancel = { result: r, msToFirstUpdate: tc - t0, msCancelToResponse: Date.now() - tc, updates: kinds(from) };
  } else {
    const from = updates.length; const t0 = Date.now();
    const r = await request("session/prompt", { sessionId, prompt: [{ type: "text", text: "What was my previous message in this session? Quote it." }] });
    out.promptAfter = { result: r, ms: Date.now() - t0, text: textOf(from) };
  }
} catch (e) {
  out.error = String(e);
}
out.requestsFromAgent = [...new Set(requestsFromAgent)];
out.allUpdateKinds = kinds();
fs.writeFileSync(`acp-probe-${mode}.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
child.stdin.end();
setTimeout(() => { child.kill("SIGTERM"); process.exit(0); }, 1500);
