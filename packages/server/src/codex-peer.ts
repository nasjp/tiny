import type { TurnImage } from "./adapter.js";
import { agentEnv } from "./agents/index.js";
import { codexDriver } from "./agents/codex.js";
import { type CodexSpawn, spawnCodexProcess } from "./codex-adapter.js";
import { JsonRpcRemoteError } from "./jsonrpc-stdio.js";
import { TINY_VERSION } from "./version.js";

/**
 * Live-join into a running Codex CLI session through its message queue.
 *
 * Measured on codex-cli 0.153.4 (2026-09-09, see docs/superpowers/specs/2026-09-09-codex-live-join-design.md):
 * `codex queue --thread <id> --message <text>` is the CLI face of the app-server's `thread/queue/add`,
 * which writes into `<CODEX_HOME>/queue_1.sqlite`; the TUI holding the thread picks the item up
 * within a few seconds when idle, or right after its current turn when busy, and runs it as a turn
 * of its own. The rollout then records the message as a UserMessage item whose `client_id` is the
 * `clientUserMessageId` handed in here — codex-live.ts reads those back, which is how a queued
 * message is known to have been taken. `thread/queue/delete` takes an untaken item back (an item
 * left behind fires the next time anyone resumes the thread, so a queued message whose CLI went
 * away MUST be deleted).
 *
 * This is the ONLY file that talks to that queue (the read side of codex's storage is codex-live.ts).
 * Every call spawns one short-lived `codex app-server` and kills it when done. Failures throw; the
 * caller falls back to refusing the turn.
 */

export interface CodexQueueMessage {
  threadId: string;
  /** Recorded on the resulting UserMessage as client_id; tiny's delivery receipt */
  clientUserMessageId: string;
  text: string;
  images?: TurnImage[];
}

export interface CodexPeerOptions {
  spawn?: CodexSpawn;
  /** How long one app-server call may take end to end (spawn + initialize + request) */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** One request against a throwaway app-server. The process is gone by the time this resolves or rejects */
async function withAppServer<T>(codexHome: string, opts: CodexPeerOptions, run: (request: (method: string, params: unknown) => Promise<unknown>) => Promise<T>): Promise<T> {
  const spawn = opts.spawn ?? spawnCodexProcess;
  const launch = codexDriver.launch ?? { command: "codex", args: ["app-server"] };
  const proc = spawn(launch, { cwd: codexHome, env: agentEnv(codexDriver, codexHome) });
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`codex app-server did not answer within ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`)), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  });
  const request = (method: string, params: unknown) => Promise.race([proc.conn.request(method, params), timeout]);
  try {
    await request("initialize", { clientInfo: { name: "tiny", version: TINY_VERSION }, capabilities: { experimentalApi: true } });
    proc.conn.notify("initialized");
    return await run(request);
  } catch (err) {
    if (err instanceof JsonRpcRemoteError) throw new Error(err.message);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    proc.kill();
  }
}

function inputOf(msg: CodexQueueMessage): unknown[] {
  return [
    { type: "text", text: msg.text },
    ...(msg.images ?? []).map((img) => ({ type: "image", url: `data:${img.mediaType};base64,${img.data}` })),
  ];
}

/** Hand a message to the CLI holding the thread. Resolves once codex has stored it in the queue */
export async function queueCodexMessage(codexHome: string, msg: CodexQueueMessage, opts: CodexPeerOptions = {}): Promise<{ queuedSubmissionId: string }> {
  return withAppServer(codexHome, opts, async (request) => {
    const res = (await request("thread/queue/add", {
      threadId: msg.threadId, input: inputOf(msg), clientUserMessageId: msg.clientUserMessageId,
    })) as { queuedSubmission?: { id?: unknown } } | null;
    const id = res?.queuedSubmission?.id;
    if (typeof id !== "string" || id === "") throw new Error("thread/queue/add did not return a queued submission id");
    return { queuedSubmissionId: id };
  });
}

/** Take an untaken message back. true = it was still queued (and is now gone); false = the CLI had already taken it */
export async function deleteCodexQueued(codexHome: string, q: { threadId: string; queuedSubmissionId: string }, opts: CodexPeerOptions = {}): Promise<boolean> {
  return withAppServer(codexHome, opts, async (request) => {
    const res = (await request("thread/queue/delete", { threadId: q.threadId, queuedSubmissionId: q.queuedSubmissionId })) as { deleted?: unknown } | null;
    return res?.deleted === true;
  });
}
