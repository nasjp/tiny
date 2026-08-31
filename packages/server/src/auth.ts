import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Stores } from "./stores.js";
import type { ApnsEnv } from "./types.js";

const PAIRING_TTL_MS = 10 * 60 * 1000;

export type Principal = { kind: "cli" } | { kind: "device" } | { kind: "session"; sessionId: string };

const SESSION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

interface SessionTokenEntry {
  sessionId: string;
  expiresAt: number;
}

export class AuthService {
  constructor(
    private stores: Stores,
    private secretFile: string,
  ) {}

  // Session-scoped tokens handed to `tiny mcp-server` (send_user_file). Held in memory only,
  // expired at turn end (SessionManager revokes). A tinyd restart wipes them all.
  // The mechanism that keeps the CLI token (top privilege) out of agent processes and Codex's config.toml
  private sessionTokens = new Map<string, SessionTokenEntry>();

  issueSessionToken(sessionId: string, ttlMs: number = SESSION_TOKEN_TTL_MS): string {
    const token = crypto.randomBytes(32).toString("hex");
    this.sessionTokens.set(token, { sessionId, expiresAt: Date.now() + ttlMs });
    return token;
  }

  revokeSessionToken(token: string): void {
    this.sessionTokens.delete(token);
  }

  revokeSessionTokens(sessionId: string): void {
    for (const [t, e] of this.sessionTokens) if (e.sessionId === sessionId) this.sessionTokens.delete(t);
  }

  sessionIdForToken(token: string): string | null {
    const e = this.sessionTokens.get(token);
    if (!e) return null;
    if (e.expiresAt <= Date.now()) {
      this.sessionTokens.delete(token);
      return null;
    }
    return e.sessionId;
  }

  /** The bearer's principal. cli / device via the legacy principal(); anything else is a session token */
  resolve(token: string): Principal | null {
    const p = this.principal(token);
    if (p === "cli") return { kind: "cli" };
    if (p === "device") return { kind: "device" };
    const sessionId = this.sessionIdForToken(token);
    return sessionId ? { kind: "session", sessionId } : null;
  }

  cliToken(): string {
    if (fs.existsSync(this.secretFile)) return fs.readFileSync(this.secretFile, "utf8").trim();
    const token = crypto.randomBytes(32).toString("hex");
    fs.mkdirSync(path.dirname(this.secretFile), { recursive: true });
    fs.writeFileSync(this.secretFile, token, { mode: 0o600 });
    return token;
  }

  createPairingCode(): { code: string; expiresAt: string } {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // excludes easily confused characters
    const code = Array.from(crypto.randomBytes(8), (b) => alphabet[b % alphabet.length]).join("");
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
    this.stores.pairings.put(code, expiresAt);
    return { code, expiresAt };
  }

  redeemPairing(code: string, name: string): { deviceId: string; bearerToken: string; e2eKey: string } | null {
    if (!this.stores.pairings.take(code)) return null;
    const deviceId = crypto.randomUUID();
    const bearerToken = crypto.randomBytes(32).toString("hex");
    const e2eKey = crypto.randomBytes(32).toString("base64");
    this.stores.devices.insert({
      id: deviceId, name, bearerToken, apnsToken: null, apnsEnv: "production", e2eKey,
      createdAt: new Date().toISOString(),
    });
    return { deviceId, bearerToken, e2eKey };
  }

  verifyBearer(token: string): boolean {
    return this.principal(token) !== null;
  }

  /**
   * Returns the token's principal. "cli" = the secret file on the Mac (full privileges),
   * "device" = a paired iPhone (everything except admin), null = invalid.
   * Admin routes (pair issuance, device revocation, push test) are restricted to "cli" only.
   */
  principal(token: string): "cli" | "device" | null {
    if (!token) return null;
    if (fs.existsSync(this.secretFile) && timingSafeEqualStr(fs.readFileSync(this.secretFile, "utf8").trim(), token)) {
      return "cli";
    }
    return this.stores.devices.byToken(token) !== null ? "device" : null;
  }

  setApnsToken(bearerToken: string, apnsToken: string, apnsEnv: ApnsEnv): boolean {
    const dev = this.stores.devices.byToken(bearerToken);
    if (!dev) return false;
    this.stores.devices.setApnsToken(dev.id, apnsToken, apnsEnv);
    return true;
  }
}

/** Constant-time string comparison, including length differences (for CLI token matching). */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
