import { b64url, pemToDer, utf8 } from "./b64.js";
import type { Env } from "./env.js";

// Apple accepts provider tokens for at most 60 minutes and allows refreshing
// at most once every 20 minutes. Regenerate at 50 minutes to stay in between
// (too old yields ExpiredProviderToken, too frequent yields
// TooManyProviderTokenUpdates).
const TOKEN_TTL_MS = 50 * 60 * 1000;

let cached: { token: string; issuedAtMs: number } | null = null;

/** Used by tests and when ExpiredProviderToken is detected. */
export function resetJwtCache(): void {
  cached = null;
}

export async function apnsJwt(env: Env, nowMs: number = Date.now()): Promise<string> {
  if (cached && nowMs - cached.issuedAtMs < TOKEN_TTL_MS) return cached.token;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(env.APNS_SIGNING_KEY),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const header = b64url(utf8(JSON.stringify({ alg: "ES256", kid: env.APNS_KEY_ID })));
  const payload = b64url(utf8(JSON.stringify({ iss: env.APNS_TEAM_ID, iat: Math.floor(nowMs / 1000) })));
  // WebCrypto ECDSA signatures come back as raw r||s (64 bytes), which is exactly the JWS format.
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    utf8(`${header}.${payload}`),
  );
  const token = `${header}.${payload}.${b64url(new Uint8Array(signature))}`;
  cached = { token, issuedAtMs: nowMs };
  return token;
}
