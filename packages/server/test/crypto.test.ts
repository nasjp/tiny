import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { openSealed, sealForDevice } from "../src/crypto.js";

const key = () => crypto.randomBytes(32).toString("base64");

describe("E2E sealing", () => {
  it("seal then open returns the original plaintext", () => {
    const k = key();
    const plain = JSON.stringify({ v: 1, body: "Requesting permission to run Bash" });
    expect(openSealed(k, sealForDevice(k, plain))).toBe(plain);
  });

  it("the nonce changes every time, so the same plaintext yields different ciphertexts", () => {
    const k = key();
    expect(sealForDevice(k, "same")).not.toBe(sealForDevice(k, "same"));
  });

  it("matches CryptoKit's combined format (nonce12 + ct + tag16)", () => {
    const k = key();
    const plain = "abc";
    const buf = Buffer.from(sealForDevice(k, plain), "base64");
    expect(buf.length).toBe(12 + Buffer.byteLength(plain) + 16);
  });

  it("decryption fails with a different key", () => {
    const sealed = sealForDevice(key(), "secret");
    expect(() => openSealed(key(), sealed)).toThrow();
  });

  it("flipping one ciphertext byte fails auth-tag verification", () => {
    const k = key();
    const buf = Buffer.from(sealForDevice(k, "secret"), "base64");
    buf[13] = buf[13]! ^ 0xff;
    expect(() => openSealed(k, buf.toString("base64"))).toThrow();
  });

  it("rejects keys that are not 32 bytes", () => {
    expect(() => sealForDevice(crypto.randomBytes(16).toString("base64"), "x")).toThrow(/32/);
  });

  it("rejects sealed data that is too short", () => {
    expect(() => openSealed(key(), Buffer.alloc(20).toString("base64"))).toThrow(/too short/);
  });
});
