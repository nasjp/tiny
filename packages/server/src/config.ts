import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export interface TinyPaths {
  home: string;
  dbFile: string;
  profilesDir: string;
  outboxDir: string;
  secretFile: string;
  port: number;
}

export function tinyPaths(env: Record<string, string | undefined> = process.env): TinyPaths {
  const home = env.TINY_HOME ?? path.join(os.homedir(), ".tiny");
  const n = Number(env.TINY_PORT);
  const port = Number.isInteger(n) && n >= 0 && n <= 65535 ? n : 7777;
  return {
    home,
    dbFile: path.join(home, "tiny.db"),
    profilesDir: path.join(home, "profiles"),
    outboxDir: path.join(home, "outbox"),
    secretFile: path.join(home, "secret"),
    port,
  };
}

export function ensureDirs(p: TinyPaths): void {
  fs.mkdirSync(p.profilesDir, { recursive: true });
  fs.mkdirSync(p.outboxDir, { recursive: true });
}
