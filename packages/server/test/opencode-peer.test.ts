import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  installOpencodePlugin, opencodePluginPath, opencodePluginSource, OPENCODE_PLUGIN_VERSION, readOpencodePlugin, removeOpencodePlugin,
} from "../src/opencode-plugin.js";
import {
  listOpencodePeers, opencodePeerAbort, opencodePeerPrompt, opencodePeerReply, opencodePermissionView, opencodeServerPermissions,
  opencodeServerReply, peerSessionBusy, peerSessionIdleAt, pickOpencodePeer, pruneOpencodePeers, type OpencodePeer,
} from "../src/opencode-peer.js";

const KEY = Symbol.for("tiny.opencode.peer");
const TUI_ARGV = ["bun", "/$bunfs/root/src/cli/tui/worker.js"];

type Hooks = { event?: (i: { event: unknown }) => Promise<void>; dispose?: () => Promise<void> };

/** A short dir: a unix socket path must stay under 104 bytes on macOS */
function shortTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeClient() {
  return {
    session: {
      promptAsync: vi.fn(async (_: unknown) => ({ data: undefined })),
      abort: vi.fn(async (_: unknown) => ({ data: true })),
    },
    postSessionIdPermissionsPermissionId: vi.fn(async (_: unknown) => ({ data: true })),
  };
}

/** Load the plugin exactly as opencode would: the generated file, imported, called with an input */
async function loadPlugin(peersDir: string, argv = TUI_ARGV, env: Record<string, string> = {}) {
  const file = path.join(shortTmp("tpl-"), "tiny.mjs");
  fs.writeFileSync(file, opencodePluginSource(peersDir));
  const mod = (await import(pathToFileURL(file).href)) as { TinyPeer: (input: unknown) => Promise<Hooks> };
  const client = fakeClient();
  const saved = { argv: process.argv, env: { ...process.env } };
  process.argv = argv;
  Object.assign(process.env, env);
  try {
    const hooks = await mod.TinyPeer({ client, directory: "/repo", worktree: "/repo" });
    return { hooks, client };
  } finally {
    process.argv = saved.argv;
    for (const k of Object.keys(env)) {
      if (saved.env[k] === undefined) delete process.env[k];
      else process.env[k] = saved.env[k];
    }
  }
}

async function waitFor<T>(fn: () => T | null | undefined, ms = 2000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

afterEach(() => {
  const peer = (globalThis as Record<symbol, { close(): void } | undefined>)[KEY];
  peer?.close();
  delete (globalThis as Record<symbol, unknown>)[KEY];
});

describe("opencode plugin ↔ opencode-peer", () => {
  it("registers a TUI process and runs a phone message through its client", async () => {
    const dir = shortTmp("tpp-");
    const { client } = await loadPlugin(dir);
    const peer = await waitFor(() => listOpencodePeers(dir)[0]);
    expect(peer).toMatchObject({ pid: process.pid, kind: "tui", directories: ["/repo"], pluginVersion: OPENCODE_PLUGIN_VERSION });
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);

    await opencodePeerPrompt(peer, {
      directory: "/repo", sessionID: "ses_1", text: "hello from the phone",
      images: [{ mediaType: "image/png", data: "iVBORw0KGgo=" }],
      model: { providerID: "opencode", modelID: "gpt-5.5" }, variant: "high", agent: "build",
    });
    expect(client.session.promptAsync).toHaveBeenCalledWith({
      path: { id: "ses_1" },
      body: {
        parts: [
          { type: "text", text: "hello from the phone" },
          { type: "file", mime: "image/png", url: "data:image/png;base64,iVBORw0KGgo=", filename: "image-1.png" },
        ],
        model: { providerID: "opencode", modelID: "gpt-5.5" }, variant: "high", agent: "build",
      },
    });

    await opencodePeerAbort(peer, { directory: "/repo", sessionID: "ses_1" });
    expect(client.session.abort).toHaveBeenCalledWith({ path: { id: "ses_1" } });
    await opencodePeerReply(peer, { directory: "/repo", sessionID: "ses_c", requestID: "per_1", reply: "once" });
    expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith({
      path: { id: "ses_c", permissionID: "per_1" }, body: { response: "once" },
    });
  });

  it("passes opencode's own refusal back as an error", async () => {
    const dir = shortTmp("tpp-");
    const { client } = await loadPlugin(dir);
    client.session.promptAsync.mockResolvedValueOnce({ error: { name: "NotFoundError", data: { message: "Session not found: ses_x" } } } as never);
    const peer = await waitFor(() => listOpencodePeers(dir)[0]);
    await expect(opencodePeerPrompt(peer, { directory: "/repo", sessionID: "ses_x", text: "hi" })).rejects.toThrow(/Session not found: ses_x/);
  });

  it("publishes what the process is doing: busy sessions, prompts (subagents' under their root), idle clearing", async () => {
    const dir = shortTmp("tpp-");
    const { hooks } = await loadPlugin(dir);
    const emit = (type: string, properties: Record<string, unknown>) => hooks.event!({ event: { type, properties } });
    await emit("session.status", { sessionID: "ses_1", status: { type: "busy" } });
    await emit("session.created", { info: { id: "ses_c", parentID: "ses_1" } });
    await emit("session.status", { sessionID: "ses_c", status: { type: "busy" } });
    await emit("permission.asked", {
      id: "per_1", sessionID: "ses_c", permission: "bash", patterns: ["echo hi"], metadata: { command: "echo hi" }, always: [],
    });
    await emit("question.asked", { id: "que_1", sessionID: "ses_1", questions: [] });
    let peer = await waitFor(() => listOpencodePeers(dir).find((p) => p.permissions.length === 1 && p.questions.length === 1));
    expect(peerSessionBusy(peer, "ses_1")).toBe(true);
    expect(peer.permissions[0]).toMatchObject({ id: "per_1", sessionID: "ses_c", root: "ses_1", permission: "bash" });
    expect(peer.questions[0]).toMatchObject({ id: "que_1", root: "ses_1" });

    // An abort ends the child without permission.replied: its idle clears what it was asking
    await emit("session.status", { sessionID: "ses_c", status: { type: "idle" } });
    await emit("question.rejected", { sessionID: "ses_1", requestID: "que_1" });
    await emit("session.status", { sessionID: "ses_1", status: { type: "idle" } });
    peer = await waitFor(() => listOpencodePeers(dir).find((p) => p.permissions.length === 0 && p.sessions.ses_1?.status === "idle"));
    expect(peer.questions).toEqual([]);
    expect(peerSessionBusy(peer, "ses_1")).toBe(false);
    expect(peerSessionIdleAt(peer, "ses_1")).toBeGreaterThan(0);
  });

  it("stays out of tiny's own children and of one-shot runs", async () => {
    for (const [argv, env] of [
      [TUI_ARGV, { TINY_OPENCODE_PEER: "off" }],
      [["bun", "/$bunfs/root/src/index.js", "acp"], {}],
      [["bun", "/$bunfs/root/src/index.js", "run", "hi"], {}],
    ] as const) {
      const dir = shortTmp("tpp-");
      const { hooks } = await loadPlugin(dir, [...argv], { ...env });
      expect(hooks).toEqual({});
      expect((globalThis as Record<symbol, unknown>)[KEY]).toBeUndefined();
      expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
    }
  });

  it("registers `opencode serve` too, and removes its files when the process goes", async () => {
    const dir = shortTmp("tpp-");
    await loadPlugin(dir, ["bun", "/$bunfs/root/src/index.js", "serve", "--port", "4096"]);
    const peer = await waitFor(() => listOpencodePeers(dir)[0]);
    expect(peer.kind).toBe("serve");
    (globalThis as Record<symbol, { close(): void }>)[KEY]!.close();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("ignores dead processes and prunes what they left", () => {
    const dir = shortTmp("tpp-");
    const reg = (pid: number) => JSON.stringify({ protocol: 1, pid, socket: path.join(dir, `${pid}.sock`), directories: ["/repo"], sessions: {} });
    fs.writeFileSync(path.join(dir, "111.json"), reg(111));
    fs.writeFileSync(path.join(dir, "111.sock"), "");
    fs.writeFileSync(path.join(dir, "222.json"), reg(222));
    fs.writeFileSync(path.join(dir, "333.json"), "{half"); // caught mid-write
    const alive = (pid: number) => pid !== 111;
    expect(listOpencodePeers(dir, alive).map((p) => p.pid)).toEqual([222]);
    expect(pruneOpencodePeers(dir, alive)).toBe(1);
    expect(fs.readdirSync(dir).sort()).toEqual(["222.json", "333.json"]);
    expect(listOpencodePeers("/no/such/dir")).toEqual([]);
  });

  it("picks the process serving the session's directory, the one that last worked on it first", () => {
    const peer = (pid: number, dirs: string[], startedAt: number, sessions: OpencodePeer["sessions"] = {}): OpencodePeer => ({
      pid, kind: "tui", dataHome: "/h", socket: "", directories: dirs, startedAt, pluginVersion: 1, sessions, permissions: [], questions: [],
    });
    const a = peer(1, ["/repo"], 100);
    const b = peer(2, ["/repo"], 200);
    const c = peer(3, ["/other"], 300);
    expect(pickOpencodePeer([a, b, c], "/repo", "ses_1")!.pid).toBe(2); // newest
    const a2 = peer(1, ["/repo"], 100, { ses_1: { status: "idle", since: 50, root: "ses_1" } });
    expect(pickOpencodePeer([a2, b, c], "/repo", "ses_1")!.pid).toBe(1); // worked on it
    expect(pickOpencodePeer([c], "/repo", "ses_1")).toBeNull();
  });

  it("shows a permission prompt the way the phone's card expects, subagents marked", () => {
    expect(opencodePermissionView({
      id: "per_1", sessionID: "ses_c", root: "ses_1", permission: "bash", patterns: ["sleep 1", "echo x"], metadata: {},
    })).toEqual({ toolName: "bash", input: { command: "sleep 1 && echo x" }, hint: { kind: "execute", summary: "(subagent) sleep 1, echo x" } });
    expect(opencodePermissionView({
      id: "per_2", sessionID: "ses_1", root: "ses_1", permission: "edit", patterns: ["src/a.ts"], metadata: { filepath: "/repo/src/a.ts", diff: "-a\n+b" },
    })).toEqual({ toolName: "edit", input: { filepath: "/repo/src/a.ts", diff: "-a\n+b" }, hint: { kind: "edit", summary: "/repo/src/a.ts" } });
  });

  it("lists and answers the permission prompts of tiny's own `opencode acp` over its HTTP server", async () => {
    const seen: Array<{ method?: string; url?: string; body: string }> = [];
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, body });
        res.setHeader("content-type", "application/json");
        if (req.method === "GET") {
          res.end(JSON.stringify([
            { id: "per_9", sessionID: "ses_child", permission: "bash", patterns: ["curl x"], metadata: { command: "curl x" }, always: [] },
          ]));
        } else {
          res.end("true");
        }
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    try {
      expect(await opencodeServerPermissions(port, "/re po")).toEqual([
        { id: "per_9", sessionID: "ses_child", permission: "bash", patterns: ["curl x"], metadata: { command: "curl x" } },
      ]);
      await opencodeServerReply(port, "/re po", "per_9", "once");
      expect(seen.map((s) => [s.method, s.url, s.body])).toEqual([
        ["GET", "/permission?directory=%2Fre%20po", ""],
        ["POST", "/permission/per_9/reply?directory=%2Fre%20po", JSON.stringify({ reply: "once" })],
      ]);
    } finally {
      srv.close();
    }
  });
});

describe("opencode plugin file", () => {
  it("installs into the profile's opencode config, reports its version, and removes only its own file", () => {
    const profileDir = shortTmp("tpf-");
    expect(readOpencodePlugin(profileDir)).toEqual({ installed: false, version: null });
    const file = installOpencodePlugin(profileDir, "/peers");
    expect(file).toBe(opencodePluginPath(profileDir));
    expect(file.endsWith(path.join("opencode", "plugin", "tiny.js"))).toBe(true);
    expect(readOpencodePlugin(profileDir)).toEqual({ installed: true, version: OPENCODE_PLUGIN_VERSION });
    expect(fs.readFileSync(file, "utf8")).toContain('const PEERS_DIR = "/peers";');
    expect(removeOpencodePlugin(profileDir)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(removeOpencodePlugin(profileDir)).toBe(false);

    // Somebody else's tiny.js is left alone
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "export const Mine = async () => ({})\n");
    expect(readOpencodePlugin(profileDir)).toEqual({ installed: false, version: null });
    expect(() => installOpencodePlugin(profileDir, "/peers")).toThrow(/not tiny's plugin/);
    expect(removeOpencodePlugin(profileDir)).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
  });
});
