import { describe, expect, it } from "vitest";
import {
  claudeKeychainService,
  migrateClaudeCredential,
  type SecurityRunner,
} from "../src/keychain.js";

// Instead of the real `security`, use a fake holding a service-name -> password Map
function fakeKeychain(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  const calls: string[][] = [];
  const run: SecurityRunner = (args, input) => {
    calls.push(args);
    if (args[0] === "find-generic-password") {
      const svc = args[args.indexOf("-s") + 1]!;
      const v = items.get(svc);
      return v == null ? { status: 44, stdout: "" } : { status: 0, stdout: `${v}\n` };
    }
    if (args[0] === "delete-generic-password") {
      items.delete(args[args.indexOf("-s") + 1]!);
      return { status: 0, stdout: "" };
    }
    if (args[0] === "-i") {
      // The `-i` line gets shell-style quote parsing. The fake parses the same way,
      // reproducing values breaking when escaping is wrong
      const m = /-s "((?:[^"\\]|\\.)*)" -w "((?:[^"\\]|\\.)*)"/.exec(input ?? "");
      if (!m) return { status: 1, stdout: "" };
      const unescape = (s: string) => s.replace(/\\(.)/g, "$1");
      items.set(unescape(m[1]!), unescape(m[2]!));
      return { status: 0, stdout: "" };
    }
    return { status: 1, stdout: "" };
  };
  return { items, calls, run };
}

const FROM = "/home/u/.tiny/profiles/work";
const TO = "/home/u/.tiny/profiles/profile-3";

describe("claudeKeychainService", () => {
  it("builds the service name from the first 8 hex chars of sha256(CLAUDE_CONFIG_DIR)", () => {
    // Value observed on a real machine at ~/.tiny/profiles/work
    expect(claudeKeychainService("/Users/alice/.tiny/profiles/work")).toBe("Claude Code-credentials-2c3ebcc4");
    expect(claudeKeychainService(FROM)).not.toBe(claudeKeychainService(TO));
  });
});

describe("migrateClaudeCredential", () => {
  const opts = { fromDir: FROM, toDir: TO, account: "u", platform: "darwin" as NodeJS.Platform };

  it("moves the token to the new service name and deletes the old item", () => {
    const secret = '{"claudeAiOauth":{"accessToken":"a\\"b\\\\c"}}';
    const kc = fakeKeychain({ [claudeKeychainService(FROM)]: secret });
    expect(migrateClaudeCredential({ ...opts, run: kc.run })).toBe("migrated");
    expect(kc.items.get(claudeKeychainService(TO))).toBe(secret);
    expect(kc.items.has(claudeKeychainService(FROM))).toBe(false);
  });

  it("never puts the token in argv (writes via stdin so ps cannot see it)", () => {
    const kc = fakeKeychain({ [claudeKeychainService(FROM)]: "s3cr3t" });
    migrateClaudeCredential({ ...opts, run: kc.run });
    expect(kc.calls.some((c) => c.includes("s3cr3t"))).toBe(false);
  });

  it("not logged in (no item) gives not-found and breaks nothing", () => {
    const kc = fakeKeychain();
    expect(migrateClaudeCredential({ ...opts, run: kc.run })).toBe("not-found");
    expect(kc.items.size).toBe(0);
  });

  it("throws when the written value cannot be read back, keeping the old item", () => {
    const kc = fakeKeychain({ [claudeKeychainService(FROM)]: "s3cr3t" });
    const corrupting: SecurityRunner = (args, input) =>
      args[0] === "-i" ? kc.run(["-i"], (input ?? "").replace("s3cr3t", "mangled")) : kc.run(args, input);
    expect(() => migrateClaudeCredential({ ...opts, run: corrupting })).toThrow();
    expect(kc.items.get(claudeKeychainService(FROM))).toBe("s3cr3t");
    expect(kc.items.has(claudeKeychainService(TO))).toBe(false);
  });

  it("does nothing outside macOS since the token lives in the directory", () => {
    const kc = fakeKeychain({ [claudeKeychainService(FROM)]: "s3cr3t" });
    expect(migrateClaudeCredential({ ...opts, platform: "linux", run: kc.run })).toBe("unsupported");
    expect(kc.calls).toEqual([]);
  });
});
