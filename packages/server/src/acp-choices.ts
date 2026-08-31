import fs from "node:fs";
import path from "node:path";
import type { ModelChoice } from "./agents/index.js";

/**
 * Model / effort choices mirrored from an ACP agent's `configOptions`.
 * An ACP agent reports what a profile can run only over a live session (the `session/new` /
 * `session/resume` responses carry `configOptions`), so the adapter harvests every response into
 * `<profileDir>/acp-choices.json` and `tiny profiles login` seeds it once; the driver's
 * `capabilities(profileDir)` serves the cache. Display data only: readers fall back to empty
 * lists and the harvest never throws into a turn.
 */

const FILE = "acp-choices.json";

export interface AcpChoices {
  models: ModelChoice[];
  efforts: string[];
  fetchedAt: string;
}

interface ConfigOption {
  category?: unknown;
  type?: unknown;
  options?: unknown;
}

/** Options of the select whose `category` matches — the same vocabulary set_config_option uses */
function selectValues(configOptions: unknown, category: string): Array<{ value: string; name: string | null }> {
  if (!Array.isArray(configOptions)) return [];
  const opt = (configOptions as ConfigOption[]).find(
    (o) => o !== null && typeof o === "object" && o.category === category && (o.type === undefined || o.type === "select"),
  );
  if (!opt || !Array.isArray(opt.options)) return [];
  const out: Array<{ value: string; name: string | null }> = [];
  for (const e of opt.options) {
    if (e === null || typeof e !== "object") continue;
    const value = (e as { value?: unknown }).value;
    if (typeof value !== "string" || value === "") continue;
    const name = (e as { name?: unknown }).name;
    out.push({ value, name: typeof name === "string" && name !== "" ? name : null });
  }
  return out;
}

/**
 * configOptions -> tiny's choice lists. Measured shapes (opencode 1.18.18 / cursor probe):
 * category "model" options are { value, name }; category "thought_level" holds the efforts.
 * null when the response carries nothing usable (e.g. a resume that reports no options).
 */
export function choicesFromConfigOptions(configOptions: unknown): { models: ModelChoice[]; efforts: string[] } | null {
  const models: ModelChoice[] = selectValues(configOptions, "model").map((o) => ({
    id: o.value,
    ...(o.name !== null ? { label: o.name } : {}),
  }));
  const efforts = selectValues(configOptions, "thought_level").map((o) => o.value);
  if (models.length === 0 && efforts.length === 0) return null;
  return { models, efforts };
}

/** The cached choices, or null when there is no cache or it is unreadable (never throws) */
export function readAcpChoices(profileDir: string): AcpChoices | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(profileDir, FILE), "utf8")) as AcpChoices;
    if (!Array.isArray(parsed.models) || !Array.isArray(parsed.efforts)) return null;
    return {
      models: parsed.models.filter(
        (m): m is ModelChoice =>
          m !== null && typeof m === "object" && typeof m.id === "string" && (m.label === undefined || typeof m.label === "string"),
      ),
      efforts: parsed.efforts.filter((e): e is string => typeof e === "string"),
      fetchedAt: typeof parsed.fetchedAt === "string" ? parsed.fetchedAt : "",
    };
  } catch {
    return null;
  }
}

export function writeAcpChoices(profileDir: string, c: { models: ModelChoice[]; efforts: string[] }): void {
  fs.writeFileSync(path.join(profileDir, FILE), JSON.stringify({ ...c, fetchedAt: new Date().toISOString() }, null, 2) + "\n");
}

/** Harvest a live response's configOptions into the cache. Never throws — display data must not break a turn */
export function harvestAcpChoices(profileDir: string, configOptions: unknown): void {
  try {
    const c = choicesFromConfigOptions(configOptions);
    if (c) writeAcpChoices(profileDir, c);
  } catch {
    // e.g. the profile directory vanished mid-turn; the pickers just stay as they were
  }
}
