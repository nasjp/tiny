import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { apnsJwt, resetJwtCache } from "../src/jwt.js";
import type { Env } from "../src/env.js";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;

const env: Env = {
  APNS_TEAM_ID: "TEAMID0000",
  APNS_KEY_ID: "KEYID00000",
  APNS_SIGNING_KEY: pem,
  APNS_TOPIC: "com.example.tiny",
};

const decode = (part: string) =>
  JSON.parse(Buffer.from(part.replaceAll("-", "+").replaceAll("_", "/"), "base64").toString("utf8")) as Record<string, unknown>;

describe("APNs ES256 JWT", () => {
  beforeEach(() => resetJwtCache());

  it("header carries alg=ES256 and kid", async () => {
    const [h] = (await apnsJwt(env, 1_756_000_000_000)).split(".");
    expect(decode(h!)).toEqual({ alg: "ES256", kid: "KEYID00000" });
  });

  it("claims are iss=TeamID and iat in seconds", async () => {
    const [, p] = (await apnsJwt(env, 1_756_000_000_000)).split(".");
    expect(decode(p!)).toEqual({ iss: "TEAMID0000", iat: 1_756_000_000 });
  });

  it("signature is JWS-style raw r||s (64 bytes) and verifies", async () => {
    const jwt = await apnsJwt(env, 1_756_000_000_000);
    const [h, p, s] = jwt.split(".");
    const sig = Buffer.from(s!.replaceAll("-", "+").replaceAll("_", "/"), "base64");
    expect(sig).toHaveLength(64);
    const pub = await crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, pub, sig, new TextEncoder().encode(`${h}.${p}`),
    );
    expect(ok).toBe(true);
  });

  it("reuses the same token within 50 minutes", async () => {
    const base = 1_756_000_000_000;
    const a = await apnsJwt(env, base);
    const b = await apnsJwt(env, base + 49 * 60 * 1000);
    expect(b).toBe(a);
  });

  it("regenerates after 50 minutes (before Apple's 60-minute cap)", async () => {
    const base = 1_756_000_000_000;
    const a = await apnsJwt(env, base);
    const b = await apnsJwt(env, base + 51 * 60 * 1000);
    expect(b).not.toBe(a);
  });

  it("resetJwtCache forces regeneration", async () => {
    const base = 1_756_000_000_000;
    const a = await apnsJwt(env, base);
    resetJwtCache();
    const b = await apnsJwt(env, base + 1000);
    expect(b).not.toBe(a);
  });
});
