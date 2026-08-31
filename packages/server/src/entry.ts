import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The "entry" of the tiny that is currently running. In development it is src/cli.ts (run via tsx); the distributed build is dist/cli.js (run via node).
 * Keep the src/dist branching in this file only (both the daemon plist and the `tiny mcp-server` spawn use it).
 */
export interface TinyEntry {
  /**
   * Absolute path of the entry file. When launched via npm's bin (`<prefix>/bin/tiny`, a symlink to `.../dist/cli.js`),
   * this is the link side. That path stays stable across package updates, so it is the one baked into the plist
   */
  file: string;
  /** Whether src/cli.ts is being run via tsx */
  isSource: boolean;
}

export interface LaunchCommand {
  command: string;
  args: string[];
}

export function tinyEntry(opts: { moduleUrl?: string; argv1?: string | null } = {}): TinyEntry {
  const moduleUrl = opts.moduleUrl ?? import.meta.url;
  const isSource = moduleUrl.endsWith(".ts");
  const real = path.join(path.dirname(fileURLToPath(moduleUrl)), isSource ? "cli.ts" : "cli.js");
  // null = do not look at argv (for tests). undefined = this process's argv[1]
  const argv1 = opts.argv1 === undefined ? process.argv[1] : opts.argv1;
  if (argv1) {
    try {
      if (fs.realpathSync(argv1) === fs.realpathSync(real)) return { file: path.resolve(argv1), isSource };
    } catch {
      // If argv[1] or the real file does not exist (e.g. under vitest), use the real file's path
    }
  }
  return { file: real, isSource };
}

/** Command to launch tiny as a child process / from launchd (absolute node path + [tsx cli] + entry file) */
export function tinyLaunch(entry: TinyEntry = tinyEntry(), execPath: string = process.execPath): LaunchCommand {
  if (entry.isSource) {
    const tsxCli = path.join(path.dirname(entry.file), "..", "node_modules", "tsx", "dist", "cli.mjs");
    if (!fs.existsSync(tsxCli)) {
      throw new Error(`tsx cli not found: ${tsxCli} (run pnpm install, or build with pnpm build and run dist/cli.js)`);
    }
    return { command: execPath, args: [tsxCli, entry.file] };
  }
  return { command: execPath, args: [entry.file] };
}
