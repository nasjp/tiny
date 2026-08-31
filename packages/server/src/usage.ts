import os from "node:os";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { agentEnv, findDriver } from "./agents/index.js";
import { codexDriver } from "./agents/codex.js";
import { spawnCodexProcess, type CodexSpawn } from "./codex-adapter.js";
import { readProfileAgent, profileDir } from "./profiles.js";
import { TINY_VERSION } from "./version.js";

// Equivalent of Claude Code's /usage. The numbers come from Claude Code itself via the
// Agent SDK's usage control request (measured: returns in about 1 second without sending
// a prompt, and no session file is created under projects/).
//
// Previously we read the OAuth token from the Keychain and, when expired, refreshed and
// wrote it back — but Anthropic legal-and-compliance states "developers may not collect,
// store, or intermediate Claude.ai credentials or session tokens".
// On this path Claude Code itself does all credential reading/refreshing/storing;
// tinyd never touches the token.

export interface UsageLimit {
  kind: string;
  label: string;
  percent: number;
  resetsAt: string | null;
}

export interface ProfileUsage {
  profile: string;
  limits: UsageLimit[];
  fetchedAt: string;
}

/** Takes the profile's CLAUDE_CONFIG_DIR and returns the raw /usage data (rate_limits) */
export type UsageFetcher = (configDir: string) => Promise<unknown>;

/**
 * Why a usage lookup did not produce numbers. The phone renders each kind differently, so this —
 * not the wording — is what it keys off:
 *   signed_out  the agent's login expired or was invalidated (fix it with `hint`)
 *   unavailable this login has no usage data at all (API key / console login / no usage scope)
 *   unsupported the agent has no usage API tiny can read
 *   failed      something broke on the way (spawn, timeout, network)
 */
export type UsageProblem = "signed_out" | "unavailable" | "unsupported" | "failed";

/**
 * A usage lookup that produced no numbers. `message` is one short line for a person, `hint` the
 * command that fixes it, and `detail` the raw upstream text — the app keeps that behind a
 * disclosure instead of pasting a 401 body across the screen.
 */
export class UsageError extends Error {
  constructor(
    readonly problem: UsageProblem,
    message: string,
    readonly hint?: string,
    readonly detail?: string,
  ) {
    super(message);
  }

  /** Nothing here is a bug in tinyd; only `failed` is an actual breakage on the way */
  get status(): 409 | 502 {
    return this.problem === "failed" ? 502 : 409;
  }
}

/** Login expired / invalidated / never happened, as reported by an agent that has no error codes for it */
const SIGNED_OUT_RE =
  /\b401\b|unauthorized|token[_ ]?(?:invalidated|expired)|invalid_grant|sign(?:ing)? in again|not logged in|login required|please log ?in/i;

/**
 * Turn whatever an agent threw into something the phone can show in two lines. The upstream text
 * is never thrown away — it moves to `detail`, where the app keeps it one tap out of sight.
 */
export function classifyUsageError(err: unknown, agent: string, profile: string): UsageError {
  if (err instanceof UsageError) return err;
  const raw = err instanceof Error ? err.message : String(err);
  const label = findDriver(agent)?.label ?? agent;
  if (SIGNED_OUT_RE.test(raw)) {
    return new UsageError("signed_out", `${label} is signed out on your Mac`, `tiny profiles login ${profile}`, raw);
  }
  return new UsageError("failed", `Could not read usage from ${label}`, undefined, raw);
}

type QueryFn = typeof sdkQuery;

export interface SdkUsageOptions {
  queryFn?: QueryFn;
  /** Working directory Claude Code is started in. Use a neutral place that picks up no project settings */
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Briefly starts Claude Code via the Agent SDK, asks for the structured /usage data, and closes.
 * The prompt is an AsyncIterable that yields nothing, so no turn ever runs.
 */
export function createSdkUsageFetcher(opts: SdkUsageOptions = {}): UsageFetcher {
  const queryFn = opts.queryFn ?? sdkQuery;
  const cwd = opts.cwd ?? os.tmpdir();
  const timeoutMs = opts.timeoutMs ?? 20_000;
  return async (configDir) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    async function* silent(): AsyncGenerator<never, void> {
      await gate;
    }
    const abort = new AbortController();
    const q = queryFn({
      prompt: silent(),
      options: {
        cwd,
        // Always drop ANTHROPIC_API_KEY: leaving it bills API pay-as-you-go instead of the subscription
        env: { ...(opts.env ?? process.env), ANTHROPIC_API_KEY: undefined, CLAUDE_CONFIG_DIR: configDir },
        abortController: abort,
      },
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new Error(`usage request timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      });
      // The SDK explicitly marks the method name EXPERIMENTAL (a future rename is expected).
      // If an SDK bump renames it, typecheck fails — keep it confined to this one call site
      const res = await Promise.race([q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(), timeout]);
      if (!res.rate_limits_available || res.rate_limits == null) {
        throw new UsageError(
          "unavailable",
          "Usage is not available for this login (an API-key or console login, or a plan that does not report usage)",
        );
      }
      return res.rate_limits;
    } finally {
      if (timer) clearTimeout(timer);
      release();
      q.close();
    }
  };
}


export interface CodexUsageOptions {
  spawn?: CodexSpawn;
  timeoutMs?: number;
}

/**
 * Codex usage. Briefly starts `codex app-server` with CODEX_HOME = the profile dir,
 * asks `account/rateLimits/read` exactly once, and closes (measured 682ms).
 * Converts the response to a shape normalizeUsage can read (limits[]).
 * Measured: `resetsAt` is UNIX **seconds**; `windowDurationMins` is 300 = 5h window / 10080 = 7-day window.
 */
export function createCodexUsageFetcher(opts: CodexUsageOptions = {}): UsageFetcher {
  const spawn = opts.spawn ?? spawnCodexProcess;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  return async (configDir) => {
    const proc = spawn(codexDriver.launch ?? { command: codexDriver.bin, args: ["app-server"] }, {
      cwd: os.tmpdir(),
      env: agentEnv(codexDriver, configDir),
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`codex usage request timed out after ${timeoutMs}ms`)), timeoutMs);
      });
      await Promise.race([
        proc.conn.request("initialize", { clientInfo: { name: "tiny", title: "tiny", version: TINY_VERSION } }),
        timeout,
      ]);
      const res = await Promise.race([proc.conn.request("account/rateLimits/read", {}), timeout]);
      return codexRateLimitsToUsage(res);
    } finally {
      if (timer) clearTimeout(timer);
      proc.conn.close();
      proc.kill();
    }
  };
}

interface CodexRateWindow {
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
}

interface CodexRateLimitsEntry {
  primary?: CodexRateWindow | null;
  secondary?: CodexRateWindow | null;
  limitName?: unknown;
}

/**
 * account/rateLimits/read response → the limits[] normalizeUsage reads.
 * Measured: the top-level `rateLimits` mirrors the `codex` bucket and only carries the
 * 10080-minute (weekly) window. The 5-hour (300-minute) window exists only under named
 * entries of `rateLimitsByLimitId` (e.g. codex_bengalfox).
 * So scan the top level plus every rateLimitsByLimitId entry, and dedupe on
 * (windowDurationMins, resetsAt) to avoid double-counting the mirror.
 */
export function codexRateLimitsToUsage(raw: unknown): { limits: unknown[] } {
  const r = raw as { rateLimits?: unknown; rateLimitsByLimitId?: unknown } | null;
  const sources: CodexRateLimitsEntry[] = [];
  if (r?.rateLimits && typeof r.rateLimits === "object") sources.push(r.rateLimits as CodexRateLimitsEntry);
  const byId = r?.rateLimitsByLimitId;
  if (byId && typeof byId === "object") {
    for (const entry of Object.values(byId as Record<string, unknown>)) {
      if (entry && typeof entry === "object") sources.push(entry as CodexRateLimitsEntry);
    }
  }

  const seen = new Set<string>();
  let weeklyAllTaken = false;
  const limits: unknown[] = [];
  for (const src of sources) {
    const name = typeof src.limitName === "string" && src.limitName !== "" ? src.limitName : "Codex";
    for (const w of [src.primary, src.secondary]) {
      if (!w || typeof w !== "object") continue;
      const mins = w.windowDurationMins;
      const resetsAt = typeof w.resetsAt === "number" ? w.resetsAt : null;
      const key = `${mins}:${resetsAt}`;
      if (seen.has(key)) continue; // avoid double-counting the codex bucket mirror
      seen.add(key);
      const percent = typeof w.usedPercent === "number" ? w.usedPercent : 0;
      const resets_at = resetsAt !== null ? new Date(resetsAt * 1000).toISOString() : null;
      if (mins === 300) {
        limits.push({ kind: "session", percent, resets_at });
      } else if (mins === 10080 && !weeklyAllTaken) {
        weeklyAllTaken = true;
        limits.push({ kind: "weekly_all", percent, resets_at });
      } else {
        // Second-and-later weekly windows, or an unknown window length → per-model display
        limits.push({ kind: "weekly_scoped", percent, resets_at, scope: { model: { display_name: name } } });
      }
    }
  }
  return { limits };
}

const KIND_LABELS: Record<string, string> = {
  session: "Session (5h)",
  weekly_all: "Weekly (all models)",
};

/**
 * Normalizes the SDK's rate_limits into the shape the app consumes.
 * If the server's raw `limits[]` array (kind / percent / resets_at / scope.model.display_name)
 * is present, use it (it even carries per-model display names); otherwise build from the typed fields.
 */
export function normalizeUsage(profile: string, raw: unknown): ProfileUsage {
  const r = (raw ?? {}) as Record<string, unknown>;
  const limitsRaw = r.limits;
  const limits: UsageLimit[] = Array.isArray(limitsRaw)
    ? limitsRaw.map((entry) => {
        const l = entry as {
          kind?: unknown;
          percent?: unknown;
          resets_at?: unknown;
          scope?: { model?: { display_name?: unknown } };
        };
        const kind = typeof l.kind === "string" ? l.kind : "unknown";
        const scopedModel =
          typeof l.scope?.model?.display_name === "string" ? l.scope.model.display_name : null;
        return {
          kind,
          label: KIND_LABELS[kind] ?? (scopedModel ? `Weekly (${scopedModel})` : kind),
          percent: typeof l.percent === "number" ? l.percent : 0,
          resetsAt: typeof l.resets_at === "string" ? l.resets_at : null,
        };
      })
    : fromTypedWindows(r);
  return { profile, limits, fetchedAt: new Date().toISOString() };
}

type Window = { utilization?: unknown; resets_at?: unknown; display_name?: unknown } | null | undefined;

function fromTypedWindows(r: Record<string, unknown>): UsageLimit[] {
  const out: UsageLimit[] = [];
  const push = (kind: string, label: string, w: Window) => {
    if (w == null || typeof w !== "object") return;
    out.push({
      kind,
      label,
      percent: typeof w.utilization === "number" ? w.utilization : 0,
      resetsAt: typeof w.resets_at === "string" ? w.resets_at : null,
    });
  };
  push("session", KIND_LABELS.session!, r.five_hour as Window);
  push("weekly_all", KIND_LABELS.weekly_all!, r.seven_day as Window);
  const scoped = Array.isArray(r.model_scoped) ? (r.model_scoped as Window[]) : [];
  for (const w of scoped) {
    const name = typeof w?.display_name === "string" ? w.display_name : "model";
    push("weekly_scoped", `Weekly (${name})`, w);
  }
  return out;
}

export interface UsageServiceOptions {
  /** Alias for the claude fetcher (backward compat; overrides fetchers.claude) */
  fetcher?: UsageFetcher;
  /** Agent id → fetcher. Defaults are claude (Agent SDK) and codex (app-server) */
  fetchers?: Record<string, UsageFetcher>;
  ttlMs?: number;
  resolveDir?: (name: string) => string;
  /** Profile name → agent id. Default reads tiny-profile.json */
  resolveAgent?: (name: string) => string;
  isLoggedIn?: (dir: string) => boolean;
}

export class UsageService {
  private cache = new Map<string, { at: number; value: ProfileUsage }>();
  // Concurrent requests for the same profile start Claude Code only once
  private inflight = new Map<string, Promise<ProfileUsage>>();
  private fetchers: Record<string, UsageFetcher>;
  private ttlMs: number;
  private resolveDir: (name: string) => string;
  private resolveAgent: (name: string) => string;
  private isLoggedIn: (dir: string, agent: string) => boolean;

  constructor(profilesDir: string, opts: UsageServiceOptions = {}) {
    this.fetchers = { claude: createSdkUsageFetcher(), codex: createCodexUsageFetcher(), ...(opts.fetchers ?? {}) };
    if (opts.fetcher) this.fetchers.claude = opts.fetcher;
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.resolveDir = opts.resolveDir ?? ((name) => profileDir(profilesDir, name));
    this.resolveAgent = opts.resolveAgent ?? ((name) => readProfileAgent(this.resolveDir(name)));
    // Login detection is per agent (claude = .credentials.json / codex = auth.json ...)
    this.isLoggedIn = opts.isLoggedIn ?? ((dir, agent) => findDriver(agent)?.isLoggedIn(dir) ?? false);
  }

  async get(profileName: string): Promise<ProfileUsage> {
    const hit = this.cache.get(profileName);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    const running = this.inflight.get(profileName);
    if (running) return running;

    const dir = this.resolveDir(profileName); // validates the name and that it exists
    const agent = this.resolveAgent(profileName);
    const fetcher = this.fetchers[agent];
    const label = findDriver(agent)?.label ?? agent;
    if (!fetcher) throw new UsageError("unsupported", `Usage is not available for ${label}`);
    if (!this.isLoggedIn(dir, agent)) {
      throw new UsageError("signed_out", `${label} is signed out on your Mac`, `tiny profiles login ${profileName}`);
    }

    const task = (async () => {
      const raw = await fetcher(dir).catch((err: unknown) => {
        throw classifyUsageError(err, agent, profileName);
      });
      const value = normalizeUsage(profileName, raw);
      this.cache.set(profileName, { at: Date.now(), value });
      return value;
    })().finally(() => this.inflight.delete(profileName));
    this.inflight.set(profileName, task);
    return task;
  }
}
