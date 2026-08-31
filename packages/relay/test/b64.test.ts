import { describe, expect, it } from "vitest";
import { b64url, pemToDer, utf8 } from "../src/b64.js";

describe("base64url helpers", () => {
  it("drops padding and uses URL-safe characters", () => {
    // 0xfb 0xff is "+/8=" in plain base64
    expect(b64url(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
  });

  it("empty array yields empty string", () => {
    expect(b64url(new Uint8Array())).toBe("");
  });

  it("utf8 encodes multibyte characters correctly", () => {
    expect(Array.from(utf8("€"))).toEqual([0xe2, 0x82, 0xac]);
  });

  it("strips PEM headers and newlines into DER", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nAQID\n-----END PRIVATE KEY-----\n";
    expect(Array.from(pemToDer(pem))).toEqual([1, 2, 3]);
  });

  it("rejects an empty PEM", () => {
    expect(() => pemToDer("-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----")).toThrow(/empty/);
  });
});
