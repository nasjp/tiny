import crypto from "node:crypto";
import path from "node:path";
import { getDriver } from "./agents/index.js";
import { sealForDevice } from "./crypto.js";
import type { TinySettings } from "./settings.js";
import type { Stores } from "./stores.js";
import type { DeviceRecord, EventRecord, SessionRecord } from "./types.js";

export const PUSH_EVENT_TYPES = [
  "permission_requested",
  "cli_question",
  "turn_completed",
  "turn_failed",
  "auth_error",
] as const;
export type PushEventType = (typeof PUSH_EVENT_TYPES)[number];

/** Contents of the ciphertext. The Phase 3 Notification Service Extension reads this shape. */
export interface PushIntent {
  v: 1;
  // session_added is not derived from an event: it announces a session that appeared from the Mac
  // side (a CLI hook, `tiny handoff`, `tiny new`) and carries eventId 0
  type: PushEventType | "session_added";
  sessionId: string;
  eventId: number;
  title: string;
  body: string;
  // tiny.question is for AskUserQuestion: no Allow/Deny actions; tapping opens the app to answer
  category: "tiny.permission" | "tiny.question" | "tiny.info";
  level: "time-sensitive" | "active";
  reqId?: string;
}

const TITLE_LIMIT = 40;
const BODY_LIMIT = 120;

/** Keeps a hung relay from leaving a dangling Promise in the resident process. */
const RELAY_TIMEOUT_MS = 10_000;

/** Reasons Apple defines as "stop sending to this token". Only these delete the token. */
const DEAD_TOKEN_REASONS = new Set(["BadDeviceToken", "Unregistered"]);
/** Topic-side misconfiguration. The token is still alive, so it must not be deleted. */
const MISCONFIG_REASONS = new Set(["DeviceTokenNotForTopic", "TopicDisallowed", "BadTopic"]);

function agentLabel(agent: string): string {
  try {
    return getDriver(agent).label;
  } catch {
    return agent; // a session from an agent this build no longer knows
  }
}

export function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

export function buildIntent(ev: EventRecord, session: SessionRecord | null): PushIntent | null {
  if (!(PUSH_EVENT_TYPES as readonly string[]).includes(ev.type)) return null;
  const type = ev.type as PushEventType;
  const rawTitle = session?.title ?? (session ? path.basename(session.cwd) : "tiny");
  const base = { v: 1 as const, type, sessionId: ev.sessionId, eventId: ev.id, title: truncate(rawTitle, TITLE_LIMIT) };

  switch (type) {
    case "permission_requested": {
      const toolName = typeof ev.payload.toolName === "string" ? ev.payload.toolName : "a tool";
      const reqId = typeof ev.payload.reqId === "string" ? ev.payload.reqId : undefined;
      const kind = typeof ev.payload.kind === "string" ? ev.payload.kind : undefined;
      const summary = typeof ev.payload.summary === "string" && ev.payload.summary.trim() !== "" ? ev.payload.summary : undefined;
      // Questions (AskUserQuestion / kind=question from other agents) are questions, not permissions.
      // Show the first question's text when possible and send with the tiny.question category,
      // which has no Allow/Deny actions (choices are answered in the app)
      const isQuestion = toolName === "AskUserQuestion" || kind === "question";
      // Use summary (what it will do) when present, otherwise the tool name
      let body = summary ? `Requesting permission to run: ${summary}` : `Requesting permission to run ${toolName}`;
      if (isQuestion) {
        const input = ev.payload.input as Record<string, unknown> | undefined;
        const questions = Array.isArray(input?.questions) ? (input.questions as Record<string, unknown>[]) : [];
        const q0 = questions[0];
        const first =
          typeof q0?.question === "string" ? (q0.question as string)
          : typeof q0?.text === "string" ? (q0.text as string)
          : summary ?? null;
        body = toolName === "AskUserQuestion"
          ? (first ? `Claude asks: ${first}` : "Claude is asking you a question")
          : (first ? `Question: ${first}` : "The agent is asking you a question");
      }
      return {
        ...base,
        body: truncate(body, BODY_LIMIT),
        category: isQuestion ? "tiny.question" : "tiny.permission",
        level: "time-sensitive",
        ...(reqId === undefined ? {} : { reqId }),
      };
    }
    // A question the CLI asked its person. Same category as an AskUserQuestion tiny drove itself:
    // no Allow/Deny actions, tapping opens the app, where it can be answered
    case "cli_question": {
      const input = ev.payload.input as Record<string, unknown> | undefined;
      const questions = Array.isArray(input?.questions) ? (input.questions as Record<string, unknown>[]) : [];
      const first = typeof questions[0]?.question === "string" ? (questions[0].question as string) : null;
      return {
        ...base,
        body: truncate(first ? `Claude asks: ${first}` : "Claude is asking you a question", BODY_LIMIT),
        category: "tiny.question",
        level: "time-sensitive",
      };
    }
    case "turn_completed": {
      const text = typeof ev.payload.resultText === "string" && ev.payload.resultText.trim() !== ""
        ? ev.payload.resultText
        : "Turn completed";
      return { ...base, body: truncate(text, BODY_LIMIT), category: "tiny.info", level: "active" };
    }
    case "turn_failed": {
      const detail = typeof ev.payload.error === "string"
        ? ev.payload.error
        : typeof ev.payload.subtype === "string"
          ? ev.payload.subtype
          : "unknown";
      return {
        ...base,
        body: truncate(`Turn failed: ${detail}`, BODY_LIMIT),
        category: "tiny.info",
        level: "active",
      };
    }
    case "auth_error": {
      const profile = session?.profile ?? "<name>";
      return {
        ...base,
        body: truncate(`Auth error: run \`tiny profiles login ${profile}\` on your Mac`, BODY_LIMIT),
        category: "tiny.info",
        level: "active",
      };
    }
  }
}

/**
 * A session that showed up from the Mac. There is no event to build from — an adopted session has
 * not necessarily said anything yet — so the record alone names it (cwd basename, like every
 * other intent for an untitled session) and the body says which agent and where
 */
export function buildSessionAddedIntent(session: SessionRecord, agentLabel: string): PushIntent {
  return {
    v: 1,
    type: "session_added",
    sessionId: session.id,
    eventId: 0,
    title: truncate(session.title ?? path.basename(session.cwd), TITLE_LIMIT),
    body: truncate(`New ${agentLabel} session on your Mac · ${session.cwd}`, BODY_LIMIT),
    category: "tiny.info",
    level: "active",
  };
}

/**
 * Always send a value regardless of type, so the relay cannot tell "is this a pending permission?".
 * Only pending permissions get a per-event value — APNs only replaces notifications with the same
 * value, so a different value every time is behaviorally equivalent to "no collapse".
 * The device key is the HMAC key, so the relay learns neither the session id nor cross-device identity.
 */
export function collapseIdFor(intent: PushIntent, device: DeviceRecord): string {
  const scope = intent.type === "permission_requested"
    ? `${intent.sessionId}:${intent.eventId}`
    : intent.sessionId;
  return crypto
    .createHmac("sha256", Buffer.from(device.e2eKey, "base64"))
    .update(scope)
    .digest("hex")
    .slice(0, 32);
}

export interface RelayResponse {
  ok?: boolean;
  status?: number;
  reason?: string;
  apnsId?: string | null;
  error?: string;
}

export interface PushClientDeps {
  stores: Stores;
  /** Re-read on every send. `tiny push config` changes take effect without a restart. */
  settings: () => TinySettings;
  fetchImpl?: typeof fetch;
}

/** Interface satisfied by SessionManager (narrowed so tests need not build a full EventEmitter). */
export interface EventSource {
  on(event: "event", listener: (ev: EventRecord) => void): unknown;
  on(event: "session_added", listener: (s: SessionRecord) => void): unknown;
}

export class PushClient {
  constructor(private deps: PushClientDeps) {}

  attach(manager: EventSource): void {
    manager.on("event", (ev) => {
      void this.handleEvent(ev);
    });
    manager.on("session_added", (s) => {
      void this.handleSessionAdded(s);
    });
  }

  /** Same never-throws contract as handleEvent */
  async handleSessionAdded(s: SessionRecord): Promise<void> {
    try {
      const settings = this.deps.settings();
      if (!settings.pushEnabled || settings.relayUrl === "") return;
      await this.deliver(buildSessionAddedIntent(s, agentLabel(s.agent)));
    } catch (err) {
      console.error("[tinyd] push delivery error:", err);
    }
  }

  /** Never lets exceptions escape, so a push failure cannot take down turn execution. */
  async handleEvent(ev: EventRecord): Promise<void> {
    try {
      const settings = this.deps.settings();
      if (!settings.pushEnabled || settings.relayUrl === "") return;
      const intent = buildIntent(ev, this.deps.stores.sessions.get(ev.sessionId));
      if (!intent) return;
      await this.deliver(intent);
    } catch (err) {
      console.error("[tinyd] push delivery error:", err);
    }
  }

  async deliver(intent: PushIntent): Promise<RelayResponse[]> {
    const settings = this.deps.settings();
    const relayUrl = settings.relayUrl.replace(/\/+$/, "");
    if (relayUrl === "") return [];
    const targets = this.deps.stores.devices.list().filter((d) => d.apnsToken !== null);
    const results: RelayResponse[] = [];
    for (const device of targets) {
      results.push(await this.sendToDevice(device, intent, relayUrl));
    }
    return results;
  }

  private async sendToDevice(device: DeviceRecord, intent: PushIntent, relayUrl: string): Promise<RelayResponse> {
    const doFetch = this.deps.fetchImpl ?? fetch;
    const collapseId = collapseIdFor(intent, device);
    try {
      const res = await doFetch(`${relayUrl}/v1/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
        body: JSON.stringify({
          deviceToken: device.apnsToken,
          apnsEnv: device.apnsEnv,
          payload: sealForDevice(device.e2eKey, JSON.stringify(intent)),
          collapseId,
          priority: 10,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as RelayResponse;
      if (!res.ok) {
        console.error(`[tinyd] relay returned an error ${res.status}: ${body.error ?? ""}`);
        return { ok: false, status: res.status, ...(body.error === undefined ? {} : { error: body.error }) };
      }
      if (body.ok === false && body.reason !== undefined) {
        if (DEAD_TOKEN_REASONS.has(body.reason)) {
          this.deps.stores.devices.clearApnsToken(device.id);
          console.error(`[tinyd] removed the APNs token of ${device.name} as dead (${body.reason})`);
        } else if (MISCONFIG_REASONS.has(body.reason)) {
          console.error(
            `[tinyd] APNs rejected the topic (${body.reason}). Check the relay APNS_TOPIC and the p8 team/app. Keeping the token`,
          );
        }
      }
      return body;
    } catch (err) {
      console.error(`[tinyd] failed to reach the relay (${device.name}):`, err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
