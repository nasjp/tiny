import fs from "node:fs";
import path from "node:path";

/** Absolute path of the first executable found scanning PATH from the front (regular file, executable). Null if none */
export function findOnPath(bin: string, pathEnv: string | undefined = process.env.PATH): string | null {
  for (const dir of (pathEnv ?? "").split(path.delimiter).filter((d) => d !== "")) {
    const candidate = path.join(dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Move on to the next directory
    }
  }
  return null;
}

export function isOnPath(bin: string, pathEnv?: string): boolean {
  return findOnPath(bin, pathEnv) !== null;
}
