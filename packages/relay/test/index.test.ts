import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../src/index.js";
import { resetJwtCache } from "../src/jwt.js";
import type { Env } from "../src/env.js";

const pem = generateKeyPairSync("ec", { namedCurve: "P-256" })
  .privateKey.export({ type: "pkcs8", format: "pem" }) as string;

function makeEnv(over: Partial<Env> = {}): Env {
  return {
    APNS_TEAM_ID: "TEAMID0000",
    APNS_KEY_ID: "KEYID00000",
    APNS_SIGNING_KEY: pem,
    APNS_TOPIC: "com.example.tiny",
    PUSH_LIMITER: { limit: async () => ({ success: true }) },
    ...over,
  };
}

const body = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ deviceToken: "a".repeat(64), apnsEnv: "sandbox", payload: "c2VhbGVk", ...over });

const post = (env: Env, b: string) =>
  app.request("/v1/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: b }, env);

let sent: Array<{ url: string; init: RequestInit }>;
let nextResponse: Response;

beforeEach(() => {
  resetJwtCache();
  sent = [];
  nextResponse = new Response(null, { status: 200, headers: { "apns-id": "ID-1" } });
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {} });
    return nextResponse;
  }) as unknown as typeof fetch;
});

describe("relay routes", () => {
  it("health returns ok without auth", async () => {
    const res = await app.request("/v1/health", {}, makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("happy path forwards to APNs and returns 200 ok:true", async () => {
    const res = await post(makeEnv(), body());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: 200, apnsId: "ID-1" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toContain("api.sandbox.push.apple.com");
  });

  it("returns 200 with ok:false and reason when APNs rejects", async () => {
    nextResponse = new Response(JSON.stringify({ reason: "BadDeviceToken" }), {
      status: 400, headers: { "content-type": "application/json" },
    });
    const res = await post(makeEnv(), body());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, status: 400, reason: "BadDeviceToken" });
  });

  it("defaults to production when apnsEnv is omitted", async () => {
    await post(makeEnv(), JSON.stringify({ deviceToken: "a".repeat(64), payload: "c2VhbGVk" }));
    expect(sent[0]!.url).toContain("api.push.apple.com");
  });

  it("400 when the device token is not hex", async () => {
    const res = await post(makeEnv(), body({ deviceToken: "not-hex!!" }));
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it("400 when payload is missing", async () => {
    const res = await post(makeEnv(), JSON.stringify({ deviceToken: "a".repeat(64) }));
    expect(res.status).toBe(400);
  });

  it("400 for a non-JSON body", async () => {
    const res = await app.request("/v1/push", { method: "POST", body: "not json" }, makeEnv());
    expect(res.status).toBe(400);
  });

  it("400 before hitting APNs when the payload exceeds 4096 bytes", async () => {
    const res = await post(makeEnv(), body({ payload: "A".repeat(5000) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("payload") });
    expect(sent).toHaveLength(0);
  });

  it("400 when collapseId exceeds 64 bytes (APNs cap)", async () => {
    const res = await post(makeEnv(), body({ collapseId: "x".repeat(65) }));
    expect(res.status).toBe(400);
  });

  it("429 when rate limited, without sending to APNs", async () => {
    const env = makeEnv({ PUSH_LIMITER: { limit: async () => ({ success: false }) } });
    const res = await post(env, body());
    expect(res.status).toBe(429);
    expect(sent).toHaveLength(0);
  });

  it("rate-limit key is the device token", async () => {
    const keys: string[] = [];
    const env = makeEnv({ PUSH_LIMITER: { limit: async (o) => { keys.push(o.key); return { success: true }; } } });
    await post(env, body());
    expect(keys).toEqual(["a".repeat(64)]);
  });

  it("works without the binding (self-hosted / local run)", async () => {
    const res = await post(makeEnv({ PUSH_LIMITER: undefined }), body());
    expect(res.status).toBe(200);
  });

  it("502 when APNs is unreachable", async () => {
    globalThis.fetch = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    const res = await post(makeEnv(), body());
    expect(res.status).toBe(502);
  });

  it("404 for unknown paths", async () => {
    expect((await app.request("/", {}, makeEnv())).status).toBe(404);
  });
});
