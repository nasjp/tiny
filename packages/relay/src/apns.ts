import type { Env } from "./env.js";
import { apnsJwt, resetJwtCache } from "./jwt.js";

export type ApnsEnv = "production" | "sandbox";

const HOSTS: Record<ApnsEnv, string> = {
  production: "api.push.apple.com",
  sandbox: "api.sandbox.push.apple.com",
};

/** Limit for regular notifications. APNs returns PayloadTooLarge when aps + ciphertext exceed this. */
export const APNS_PAYLOAD_LIMIT = 4096;

/** How long APNs stores the notification. With 0 or unset it tries once and discards, so a device out of coverage loses it. */
const EXPIRATION_SECONDS = 3600;

export interface SendApnsInput {
  deviceToken: string;
  apnsEnv: ApnsEnv;
  /** base64 sealed by tinyd with the e2eKey. The relay cannot decrypt it. */
  payload: string;
  collapseId?: string;
  priority?: 10 | 5;
}

export interface SendApnsResult {
  ok: boolean;
  status: number;
  reason?: string;
  apnsId: string | null;
}

/**
 * Body sent to APNs. The alert is a fixed placeholder; the real title, body,
 * kind, and session-id all live inside the ciphertext in `p`. mutable-content:1
 * launches the iOS Notification Service Extension, which replaces the content
 * with the decrypted payload.
 *
 * When the NSE cannot decrypt, it suppresses display with empty content, so
 * this placeholder is only ever visible in the rare case where the NSE itself
 * fails to launch. It is in English because the app is English-only (2026-08-30).
 */
export function buildApnsBody(payload: string): string {
  return JSON.stringify({
    aps: {
      alert: { title: "tiny", body: "New activity" },
      "mutable-content": 1,
      sound: "default",
    },
    p: payload,
  });
}

export async function sendApns(
  env: Env,
  input: SendApnsInput,
  fetchImpl: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<SendApnsResult> {
  const headers: Record<string, string> = {
    authorization: `bearer ${await apnsJwt(env, nowMs)}`,
    "apns-topic": env.APNS_TOPIC,
    "apns-push-type": "alert",
    "apns-priority": String(input.priority ?? 10),
    "apns-expiration": String(Math.floor(nowMs / 1000) + EXPIRATION_SECONDS),
    "content-type": "application/json",
  };
  if (input.collapseId) headers["apns-collapse-id"] = input.collapseId;

  const res = await fetchImpl(
    `https://${HOSTS[input.apnsEnv]}/3/device/${encodeURIComponent(input.deviceToken)}`,
    { method: "POST", headers, body: buildApnsBody(input.payload) },
  );

  const apnsId = res.headers.get("apns-id");
  if (res.status === 200) return { ok: true, status: 200, apnsId };

  let reason = "Unknown";
  try {
    const body = (await res.json()) as { reason?: string };
    if (typeof body.reason === "string") reason = body.reason;
  } catch {
    // APNs sometimes returns non-JSON (e.g. HTML on 503). Leaving reason as Unknown is fine.
  }
  // Regenerate on expiry; otherwise every send keeps failing with 403.
  if (reason === "ExpiredProviderToken") resetJwtCache();
  return { ok: false, status: res.status, reason, apnsId };
}
