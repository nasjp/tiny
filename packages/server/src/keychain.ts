import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

// Claude Code on macOS stores the OAuth token in the Keychain under
// `Claude Code-credentials-<first 8 hex chars of sha256(CLAUDE_CONFIG_DIR)>`.
// The service name is path-derived, so moving the profile directory makes the
// credential unreachable = effectively logs out. rename carries it along.
export function claudeKeychainService(configDir: string): string {
  const hash = crypto.createHash("sha256").update(configDir).digest("hex").slice(0, 8);
  return `Claude Code-credentials-${hash}`;
}

export interface RunResult {
  status: number | null;
  stdout: string;
}

/** Runs `security`. Factored out so tests can swap it */
export type SecurityRunner = (args: string[], input?: string) => RunResult;

export const defaultSecurityRunner: SecurityRunner = (args, input) => {
  const r = spawnSync("security", args, { encoding: "utf8", ...(input == null ? {} : { input }) });
  return { status: r.status, stdout: r.stdout ?? "" };
};

// Putting the token in argv makes it visible to other processes via `ps`, so writes
// go through `security -i` (reads commands from stdin). The -i line parses quotes
// shell-style, so `\` and `"` in values need escaping
function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export type KeychainMigration = "migrated" | "not-found" | "unsupported";

/**
 * Moves the Claude credential from the service name derived from the old CLAUDE_CONFIG_DIR
 * to the new one, then deletes the old item.
 * Outside macOS the token lives in `<dir>/.credentials.json` and moves with the directory, so do nothing.
 */
export function migrateClaudeCredential(opts: {
  fromDir: string;
  toDir: string;
  account: string;
  platform?: NodeJS.Platform;
  run?: SecurityRunner;
}): KeychainMigration {
  const platform = opts.platform ?? process.platform;
  if (platform !== "darwin") return "unsupported";
  const run = opts.run ?? defaultSecurityRunner;

  const from = claudeKeychainService(opts.fromDir);
  const to = claudeKeychainService(opts.toDir);
  if (from === to) return "migrated";

  const found = run(["find-generic-password", "-s", from, "-w"]);
  // A profile that never logged in has no item. Nothing to move, so treat as success
  if (found.status !== 0) return "not-found";
  const secret = found.stdout.replace(/\n$/, "");
  if (secret === "") return "not-found";

  const added = run(
    ["-i"],
    `add-generic-password -U -a ${quote(opts.account)} -s ${quote(to)} -w ${quote(secret)}\n`,
  );
  if (added.status !== 0) throw new Error(`failed to write keychain item: ${to}`);

  // -i goes through escaping, so always read back and verify the written value matches the original
  const back = run(["find-generic-password", "-s", to, "-w"]);
  if (back.status !== 0 || back.stdout.replace(/\n$/, "") !== secret) {
    run(["delete-generic-password", "-s", to]);
    throw new Error(`keychain item ${to} did not round-trip; left ${from} untouched`);
  }

  // The old item is a live token; never leave it behind
  run(["delete-generic-password", "-s", from]);
  return "migrated";
}
