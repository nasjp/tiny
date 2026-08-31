import { createRequire } from "node:module";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

/** Version of tinyd / the tiny CLI (package.json is the source of truth) */
export const TINY_VERSION: string = pkg.version;
