import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApnsBody, sendApns } from "../src/apns.js";
import { resetJwtCache } from "../src/jwt.js";
import type { Env } from "../src/env.js";

const pem = generateKeyPairSync("ec", { namedCurve: "P-256" })
  .privateKey.export({ type: "pkcs8", format: "pem" }) as string;

const env: Env = {
  APNS_TEAM_ID: "TEAMID0000",
  APNS_KEY_ID: "KEYID00000",
  APNS_SIGNING_KEY: pem,
  APNS_TOPIC: "com.example.tiny",
};

interface Captured { url: string; init: RequestInit }

function stubFetch(res: Response, captured: Captured[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} });
    return res;
  }) as unknown as typeof fetch;
}

const okRes = () => new Response(null, { status: 200, headers: { "apns-id": "AAAA-BBBB" } });
const errRes = (status: number, reason: string) =>
  new Response(JSON.stringify({ reason }), { status, headers: { "content-type": "application/json", "apns-id": "CCCC" } });

const input = { deviceToken: "a".repeat(64), apnsEnv: "production" as const, payload: "c2VhbGVk" };

describe("APNs send", () => {
  beforeEach(() => resetJwtCache());

  it("aps is a fixed placeholder; the real content hides in the p ciphertext", () => {
    const body = JSON.parse(buildApnsBody("BLOB")) as Record<string, unknown>;
    expect(body).toEqual({
      aps: { alert: { title: "tiny", body: "New activity" }, "mutable-content": 1, sound: "default" },
      p: "BLOB",
    });
  });

  it("POSTs to /3/device/<token> on the production host", async () => {
    const captured: Captured[] = [];
    await sendApns(env, input, stubFetch(okRes(), captured));
    expect(captured[0]!.url).toBe(`https://api.push.apple.com/3/device/${"a".repeat(64)}`);
    expect(captured[0]!.init.method).toBe("POST");
  });

  it("sends to the sandbox host when apnsEnv is sandbox", async () => {
    const captured: Captured[] = [];
    await sendApns(env, { ...input, apnsEnv: "sandbox" }, stubFetch(okRes(), captured));
    expect(captured[0]!.url).toContain("api.sandbox.push.apple.com");
  });

  it("sets the required APNs headers", async () => {
    const captured: Captured[] = [];
    await sendApns(env, input, stubFetch(okRes(), captured));
    const h = captured[0]!.init.headers as Record<string, string>;
    expect(h["apns-topic"]).toBe("com.example.tiny");
    expect(h["apns-push-type"]).toBe("alert");
    expect(h["apns-priority"]).toBe("10");
    expect(h.authorization).toMatch(/^bearer eyJ/);
    expect(h["apns-collapse-id"]).toBeUndefined();
  });

  it("computes apns-expiration from nowMs", async () => {
    const captured: Captured[] = [];
    const nowMs = 1_756_000_000_000;
    await sendApns(env, input, stubFetch(okRes(), captured), nowMs);
    const h = captured[0]!.init.headers as Record<string, string>;
    expect(h["apns-expiration"]).toBe(String(Math.floor(nowMs / 1000) + 3600));
  });

  it("apns-expiration is the same regardless of collapseId presence", async () => {
    const captured: Captured[] = [];
    const nowMs = 1_756_000_000_000;
    await sendApns(env, input, stubFetch(okRes(), captured), nowMs);
    await sendApns(env, { ...input, collapseId: "abc123" }, stubFetch(okRes(), captured), nowMs);
    const headers = captured.map((c) => (c.init.headers as Record<string, string>)["apns-expiration"]);
    expect(headers[0]).toBe(headers[1]);
    expect(headers[0]).toBe(String(Math.floor(nowMs / 1000) + 3600));
  });

  it("passes through collapseId and priority when given", async () => {
    const captured: Captured[] = [];
    await sendApns(env, { ...input, collapseId: "abc123", priority: 5 }, stubFetch(okRes(), captured));
    const h = captured[0]!.init.headers as Record<string, string>;
    expect(h["apns-collapse-id"]).toBe("abc123");
    expect(h["apns-priority"]).toBe("5");
  });

  it("returns ok=true and apns-id on 200", async () => {
    const r = await sendApns(env, input, stubFetch(okRes(), []));
    expect(r).toEqual({ ok: true, status: 200, apnsId: "AAAA-BBBB" });
  });

  it("returns 400 BadDeviceToken with the reason", async () => {
    const r = await sendApns(env, input, stubFetch(errRes(400, "BadDeviceToken"), []));
    expect(r).toEqual({ ok: false, status: 400, reason: "BadDeviceToken", apnsId: "CCCC" });
  });

  it("returns 410 Unregistered with the reason", async () => {
    const r = await sendApns(env, input, stubFetch(errRes(410, "Unregistered"), []));
    expect(r.status).toBe(410);
    expect(r.reason).toBe("Unregistered");
  });

  it("survives a non-JSON error body and returns Unknown", async () => {
    const r = await sendApns(env, input, stubFetch(new Response("<html>502</html>", { status: 503 }), []));
    expect(r).toMatchObject({ ok: false, status: 503, reason: "Unknown" });
  });

  it("creates a fresh JWT on the send after ExpiredProviderToken", async () => {
    const captured: Captured[] = [];
    const base = 1_756_000_000_000;
    await sendApns(env, input, stubFetch(okRes(), captured), base);
    await sendApns(env, input, stubFetch(errRes(403, "ExpiredProviderToken"), captured), base + 1000);
    await sendApns(env, input, stubFetch(okRes(), captured), base + 2000);
    const auth = captured.map((c) => (c.init.headers as Record<string, string>).authorization);
    expect(auth[1]).toBe(auth[0]);      // the failing send still used the cache
    expect(auth[2]).not.toBe(auth[1]);  // regenerated after the failure
  });
});
