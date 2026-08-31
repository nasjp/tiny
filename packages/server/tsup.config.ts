import { defineConfig } from "tsup";

// Distribution build. Bundles only our own code into dist/ with src/cli.ts as the entry.
// dependencies (better-sqlite3 = native / Agent SDK = ships its own cli.js / hono ...) are not bundled
// (tsup externalizes package.json dependencies by default).
// Dynamic imports (./server.js / ./mcp-server.js / ./daemon.js) are split into chunks by splitting, so `tiny ls`
// avoids loading the whole server stack. esbuild keeps the entry's shebang (#!/usr/bin/env node) as is.
export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  splitting: true,
  sourcemap: false,
  dts: false,
});
