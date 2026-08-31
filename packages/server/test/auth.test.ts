import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db.js";
import { createStores } from "../src/stores.js";
import { AuthService } from "../src/auth.js";

describe("AuthService", () => {
  let auth: AuthService;
  let secretFile: string;
  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-auth-"));
    secretFile = path.join(dir, "secret");
    auth = new AuthService(createStores(openDb(":memory:")), secretFile);
  });

  it("cliToken persists, re-reads to the same value, and has 0600 permissions", () => {
    const t1 = auth.cliToken();
    expect(t1).toHaveLength(64);
    expect(auth.cliToken()).toBe(t1);
    expect(fs.statSync(secretFile).mode & 0o777).toBe(0o600);
    expect(auth.verifyBearer(t1)).toBe(true);
  });

  it("a pairing code registers a device and is single-use", () => {
    const { code } = auth.createPairingCode();
    expect(code).toMatch(/^[A-Z0-9]{8}$/);
    const dev = auth.redeemPairing(code, "iPhone")!;
    expect(dev.bearerToken).toHaveLength(64);
    expect(dev.e2eKey).toHaveLength(44); // 32byte base64
    expect(auth.verifyBearer(dev.bearerToken)).toBe(true);
    expect(auth.redeemPairing(code, "iPhone2")).toBeNull();
  });

  it("principal returns the token's principal (cli / device / null)", () => {
    const cli = auth.cliToken();
    const { code } = auth.createPairingCode();
    const dev = auth.redeemPairing(code, "iPhone")!;
    expect(auth.principal(cli)).toBe("cli");
    expect(auth.principal(dev.bearerToken)).toBe("device");
    expect(auth.principal("bogus")).toBeNull();
    expect(auth.principal("")).toBeNull();
  });

  it("rejects invalid tokens / can store an APNs token", () => {
    expect(auth.verifyBearer("bogus")).toBe(false);
    const { code } = auth.createPairingCode();
    const dev = auth.redeemPairing(code, "iPhone")!;
    expect(auth.setApnsToken(dev.bearerToken, "apns-1", "sandbox")).toBe(true);
    expect(auth.setApnsToken("bogus", "apns-1", "sandbox")).toBe(false);
  });

  it("can issue, verify, and revoke session tokens (memory-only, a principal distinct from cli/device)", () => {
    const t = auth.issueSessionToken("sess-1");
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(auth.sessionIdForToken(t)).toBe("sess-1");
    expect(auth.resolve(t)).toEqual({ kind: "session", sessionId: "sess-1" });
    // Never appears in the existing principal() (leaves admin-route checks unchanged)
    expect(auth.principal(t)).toBeNull();
    expect(auth.verifyBearer(t)).toBe(false);
    auth.revokeSessionToken(t);
    expect(auth.sessionIdForToken(t)).toBeNull();
    expect(auth.resolve(t)).toBeNull();
  });

  it("revokeSessionTokens removes all of a session's tokens and keeps other sessions'", () => {
    const a1 = auth.issueSessionToken("sess-a");
    const a2 = auth.issueSessionToken("sess-a");
    const b = auth.issueSessionToken("sess-b");
    auth.revokeSessionTokens("sess-a");
    expect(auth.sessionIdForToken(a1)).toBeNull();
    expect(auth.sessionIdForToken(a2)).toBeNull();
    expect(auth.sessionIdForToken(b)).toBe("sess-b");
  });

  it("session tokens expire by TTL", () => {
    vi.useFakeTimers();
    try {
      const t = auth.issueSessionToken("sess-1", 1000);
      vi.advanceTimersByTime(999);
      expect(auth.sessionIdForToken(t)).toBe("sess-1");
      vi.advanceTimersByTime(2);
      expect(auth.sessionIdForToken(t)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolve still returns cli / device as before", () => {
    expect(auth.resolve(auth.cliToken())).toEqual({ kind: "cli" });
    const { code } = auth.createPairingCode();
    const dev = auth.redeemPairing(code, "iPhone")!;
    expect(auth.resolve(dev.bearerToken)).toEqual({ kind: "device" });
    expect(auth.resolve("nope")).toBeNull();
  });
});
