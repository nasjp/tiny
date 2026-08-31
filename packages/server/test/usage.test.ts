import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  classifyUsageError,
  createCodexUsageFetcher,
  createSdkUsageFetcher,
  normalizeUsage,
  UsageError,
  UsageService,
} from "../src/usage.js";
import { fakeCodexServer } from "./fake-codex-server.js";

// Condensed SDK usage response (rate_limits). limits[] is the server's raw array behind the /usage display
const RATE_LIMITS = {
  five_hour: { utilization: 29, resets_at: "2026-08-29T07:39:59Z" },
  seven_day: { utilization: 7, resets_at: "2026-09-03T01:59:59Z" },
  limits: [
    { kind: "session", percent: 29, resets_at: "2026-08-29T07:39:59Z", scope: null },
    { kind: "weekly_all", percent: 7, resets_at: "2026-09-03T01:59:59Z", scope: null },
    { kind: "weekly_scoped", percent: 50, resets_at: "2026-09-03T01:59:59Z", scope: { model: { display_name: "Fable" } } },
  ],
};

/** Fake query(). Records the usage response (or exception), the arguments passed, and close calls */
function fakeQuery(result: unknown | Error, opts: { delayMs?: number } = {}) {
  const calls: { args: unknown; closed: boolean }[] = [];
  const queryFn = (args: unknown) => {
    const rec = { args, closed: false };
    calls.push(rec);
    return {
      async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        if (result instanceof Error) throw result;
        return result;
      },
      close() {
        rec.closed = true;
      },
    };
  };
  return { calls, queryFn: queryFn as unknown as Parameters<typeof createSdkUsageFetcher>[0] extends infer O ? NonNullable<O extends { queryFn?: infer Q } ? Q : never> : never };
}

describe("createSdkUsageFetcher", () => {
  it("starts Claude Code with the profile's CLAUDE_CONFIG_DIR, drops the API key, returns rate_limits, and closes", async () => {
    const fq = fakeQuery({ rate_limits_available: true, rate_limits: RATE_LIMITS });
    const fetch = createSdkUsageFetcher({
      queryFn: fq.queryFn,
      cwd: "/tmp/neutral",
      env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-must-not-leak" },
    });
    await expect(fetch("/home/u/.tiny/profiles/work")).resolves.toBe(RATE_LIMITS);
    expect(fq.calls).toHaveLength(1);
    const args = fq.calls[0]!.args as { options: { cwd: string; env: Record<string, unknown> } };
    expect(args.options.cwd).toBe("/tmp/neutral");
    expect(args.options.env.CLAUDE_CONFIG_DIR).toBe("/home/u/.tiny/profiles/work");
    expect(args.options.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect("ANTHROPIC_API_KEY" in args.options.env).toBe(false); // the SDK copies options.env wholesale
    expect(args.options.env.PATH).toBe("/usr/bin");
    expect(fq.calls[0]!.closed).toBe(true);
  });

  // Claude Code looks its config file up asymmetrically: unset it reads ~/.claude.json, set to
  // $X it reads $X/.claude.json — which ~/.claude does not have. Naming the default directory
  // therefore hands the process an empty config, and `claude auth status` there answers
  // "loggedIn: false" — measured on device, and the reason the `local` profile never had usage
  it("never names Claude Code's own default directory (that logs the process out)", async () => {
    const fq = fakeQuery({ rate_limits_available: true, rate_limits: RATE_LIMITS });
    const home = path.join(os.homedir(), ".claude");
    await createSdkUsageFetcher({ queryFn: fq.queryFn, env: { PATH: "/usr/bin" } })(home);
    const args = fq.calls[0]!.args as { options: { env: Record<string, string> } };
    expect("CLAUDE_CONFIG_DIR" in args.options.env).toBe(false);
  });

  // Measured on this Mac's default profile: a fresh process answers "limits are available" and
  // then hands over nothing, while Claude Code's own cache in .claude.json holds the numbers the
  // person sees in /usage. Showing those, stamped with when they were written, beats showing nothing
  it("falls back to Claude Code's own cached numbers when the process hands over none", async () => {
    const fq = fakeQuery({ rate_limits_available: true, rate_limits: null });
    const cached = {
      raw: { limits: [{ kind: "session", percent: 43, resets_at: "2026-08-31T13:10:00Z", scope: null }] },
      fetchedAt: "2026-08-31T12:36:21.277Z",
    };
    const raw = await createSdkUsageFetcher({ queryFn: fq.queryFn, readCached: () => cached })("/p");
    const usage = normalizeUsage("local", raw);
    expect(usage.limits).toEqual([
      { kind: "session", label: "Session (5h)", percent: 43, resetsAt: "2026-08-31T13:10:00Z" },
    ]);
    expect(usage.fetchedAt).toBe("2026-08-31T12:36:21.277Z");
  });

  it("still says unavailable when there is no cache to fall back on", async () => {
    const fq = fakeQuery({ rate_limits_available: false, rate_limits: null });
    const err = await createSdkUsageFetcher({ queryFn: fq.queryFn, readCached: () => null })("/p")
      .catch((e: unknown) => e);
    expect((err as UsageError).problem).toBe("unavailable");
  });

  it("prefers what the process reports over the cache", async () => {
    const fq = fakeQuery({ rate_limits_available: true, rate_limits: RATE_LIMITS });
    const readCached = vi.fn(() => ({ raw: { limits: [] }, fetchedAt: "2020-01-01T00:00:00Z" }));
    const usage = normalizeUsage("work", await createSdkUsageFetcher({ queryFn: fq.queryFn, readCached })("/p"));
    expect(readCached).not.toHaveBeenCalled();
    expect(usage.limits).toHaveLength(3);
  });

  it("the prompt streams nothing (never runs a turn)", async () => {
    const fq = fakeQuery({ rate_limits_available: true, rate_limits: RATE_LIMITS });
    await createSdkUsageFetcher({ queryFn: fq.queryFn })("/p");
    const args = fq.calls[0]!.args as { prompt: AsyncIterable<unknown> };
    // Even draining after close yields nothing
    const seen: unknown[] = [];
    for await (const m of args.prompt) seen.push(m);
    expect(seen).toEqual([]);
  });

  it("not a subscription / missing scope (rate_limits_available=false) is an \"unavailable\" UsageError, and the process closes", async () => {
    const fq = fakeQuery({ rate_limits_available: false, rate_limits: null });
    const err = await createSdkUsageFetcher({ queryFn: fq.queryFn })("/p").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect((err as UsageError).problem).toBe("unavailable");
    expect(fq.calls[0]!.closed).toBe(true);
  });

  it("always closes even when the SDK throws", async () => {
    const fq = fakeQuery(new Error("bridge died"));
    await expect(createSdkUsageFetcher({ queryFn: fq.queryFn })("/p")).rejects.toThrow(/bridge died/);
    expect(fq.calls[0]!.closed).toBe(true);
  });

  it("times out and closes when the response is slow", async () => {
    const fq = fakeQuery({ rate_limits_available: true, rate_limits: RATE_LIMITS }, { delayMs: 200 });
    await expect(createSdkUsageFetcher({ queryFn: fq.queryFn, timeoutMs: 20 })("/p")).rejects.toThrow(/timed out/);
    expect(fq.calls[0]!.closed).toBe(true);
  });
});

describe("normalizeUsage", () => {
  it("uses limits[] when present (even picks up per-model display names)", () => {
    const u = normalizeUsage("work", RATE_LIMITS);
    expect(u.profile).toBe("work");
    expect(u.limits).toEqual([
      { kind: "session", label: "Session (5h)", percent: 29, resetsAt: "2026-08-29T07:39:59Z" },
      { kind: "weekly_all", label: "Weekly (all models)", percent: 7, resetsAt: "2026-09-03T01:59:59Z" },
      { kind: "weekly_scoped", label: "Weekly (Fable)", percent: 50, resetsAt: "2026-09-03T01:59:59Z" },
    ]);
  });

  it("builds from the typed fields (five_hour / seven_day / model_scoped) when limits[] is absent", () => {
    const u = normalizeUsage("work", {
      five_hour: { utilization: 12, resets_at: "2026-08-29T07:39:59Z" },
      seven_day: { utilization: null, resets_at: null },
      seven_day_opus: null,
      model_scoped: [{ display_name: "Opus", utilization: 3, resets_at: "2026-09-03T01:59:59Z" }],
    });
    expect(u.limits).toEqual([
      { kind: "session", label: "Session (5h)", percent: 12, resetsAt: "2026-08-29T07:39:59Z" },
      { kind: "weekly_all", label: "Weekly (all models)", percent: 0, resetsAt: null },
      { kind: "weekly_scoped", label: "Weekly (Opus)", percent: 3, resetsAt: "2026-09-03T01:59:59Z" },
    ]);
  });

  it("does not crash on empty or broken input", () => {
    expect(normalizeUsage("work", null).limits).toEqual([]);
    expect(normalizeUsage("work", { limits: "nope" }).limits).toEqual([]);
  });
});

describe("UsageService", () => {
  const profilesDir = "/does-not-matter";
  const resolveDir = (name: string) => `${profilesDir}/${name}`;

  it("a logged-out profile never starts Claude Code and says how to log in", async () => {
    const fetcher = vi.fn(async () => RATE_LIMITS);
    const usage = new UsageService(profilesDir, { fetcher, resolveDir, isLoggedIn: () => false });
    const err = await usage.get("work").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect((err as UsageError).problem).toBe("signed_out");
    expect((err as UsageError).hint).toBe("tiny profiles login work");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("passes the profile's directory to the fetcher", async () => {
    const fetcher = vi.fn(async () => RATE_LIMITS);
    const usage = new UsageService(profilesDir, { fetcher, resolveDir, isLoggedIn: () => true });
    await usage.get("work");
    expect(fetcher).toHaveBeenCalledWith(`${profilesDir}/work`);
  });

  it("does not re-call the fetcher within the TTL", async () => {
    const fetcher = vi.fn(async () => RATE_LIMITS);
    const usage = new UsageService(profilesDir, { fetcher, resolveDir, isLoggedIn: () => true, ttlMs: 60_000 });
    await usage.get("work");
    await usage.get("work");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("calls the fetcher once for concurrent requests to the same profile (no double Claude Code start)", async () => {
    const fetcher = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return RATE_LIMITS;
    });
    const usage = new UsageService(profilesDir, { fetcher, resolveDir, isLoggedIn: () => true });
    const all = await Promise.all([usage.get("work"), usage.get("work"), usage.get("work")]);
    expect(all.map((u) => u.limits.length)).toEqual([3, 3, 3]);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("retries on the next call after a fetcher failure (failures are not cached)", async () => {
    const fetcher = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("claude crashed"))
      .mockResolvedValueOnce(RATE_LIMITS);
    const usage = new UsageService(profilesDir, { fetcher, resolveDir, isLoggedIn: () => true });
    const err = await usage.get("work").catch((e: unknown) => e);
    expect((err as UsageError).detail).toBe("claude crashed");
    await expect(usage.get("work")).resolves.toMatchObject({ profile: "work" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("createCodexUsageFetcher", () => {
  // Condensed measured account/rateLimits/read response (HANDOFF "Codex app-server measurements")
  const RATE_LIMITS_RESPONSE = {
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1788490317 },
      secondary: null,
      planType: "pro",
    },
  };

  it("starts codex app-server with CODEX_HOME, converts rateLimits to limits[], and closes", async () => {
    const fake = fakeCodexServer({ onTurn: async () => null, rateLimits: RATE_LIMITS_RESPONSE });
    process.env.OPENAI_API_KEY = "sk-must-not-leak";
    try {
      const limits = (await createCodexUsageFetcher({ spawn: fake.spawn })("/p/cx")) as { limits: unknown[] };
      expect(limits).toEqual({
        limits: [{ kind: "weekly_all", percent: 12, resets_at: new Date(1788490317 * 1000).toISOString() }],
      });
      expect(fake.spawned[0]).toMatchObject({ launch: { command: "codex", args: ["app-server"] } });
      expect(fake.spawned[0]!.env.CODEX_HOME).toBe("/p/cx");
      expect(fake.spawned[0]!.env.OPENAI_API_KEY).toBeUndefined();
      expect(fake.killed).toBe(1);
      expect(fake.received.map((r) => r.method)).toEqual(["initialize", "account/rateLimits/read"]);
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("the 5-hour window is session; other windows are weekly_scoped with limitName", async () => {
    const fake = fakeCodexServer({
      onTurn: async () => null,
      rateLimits: {
        rateLimits: {
          limitName: "GPT-5.3-Codex-Spark",
          primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1788490317 },
          secondary: { usedPercent: 40, windowDurationMins: 43200, resetsAt: 1788490317 },
        },
      },
    });
    const res = (await createCodexUsageFetcher({ spawn: fake.spawn })("/p/cx")) as unknown;
    expect(normalizeUsage("cx", res).limits).toEqual([
      { kind: "session", label: "Session (5h)", percent: 3, resetsAt: new Date(1788490317 * 1000).toISOString() },
      { kind: "weekly_scoped", label: "Weekly (GPT-5.3-Codex-Spark)", percent: 40, resetsAt: new Date(1788490317 * 1000).toISOString() },
    ]);
  });

  it("times out and kills the process when the response is slow", async () => {
    const fake = fakeCodexServer({ hangInitialize: true, onTurn: async () => null });
    await expect(createCodexUsageFetcher({ spawn: fake.spawn, timeoutMs: 20 })("/p/cx")).rejects.toThrow(/timed out/);
    expect(fake.killed).toBe(1);
  });

  it("the 5-hour window exists only in rateLimitsByLimitId (measured), so scan it with the top level and dedupe", async () => {
    // Measured: the top-level rateLimits mirrors the codex bucket and only has the 10080-min window.
    // The 300-min (5-hour) window sits under named entries of rateLimitsByLimitId.
    const fake = fakeCodexServer({
      onTurn: async () => null,
      rateLimits: {
        rateLimits: { primary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1788490317 }, secondary: null },
        rateLimitsByLimitId: {
          codex: { primary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1788490317 }, secondary: null },
          codex_bengalfox: {
            limitName: "GPT-5.3-Codex-Spark",
            primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1788400000 },
            secondary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1788490317 },
          },
        },
      },
    });
    const res = (await createCodexUsageFetcher({ spawn: fake.spawn })("/p/cx")) as unknown;
    expect(normalizeUsage("cx", res).limits).toEqual([
      { kind: "weekly_all", label: "Weekly (all models)", percent: 1, resetsAt: new Date(1788490317 * 1000).toISOString() },
      { kind: "session", label: "Session (5h)", percent: 3, resetsAt: new Date(1788400000 * 1000).toISOString() },
    ]);
  });
});

describe("UsageService (per-agent fetchers)", () => {
  const resolveDir = (name: string) => `/profiles/${name}`;

  it("a codex profile calls the codex fetcher", async () => {
    const claude = vi.fn(async () => RATE_LIMITS);
    const codex = vi.fn(async () => ({ limits: [{ kind: "weekly_all", percent: 12, resets_at: null }] }));
    const usage = new UsageService("/profiles", {
      fetchers: { claude, codex },
      resolveAgent: () => "codex",
      resolveDir,
      isLoggedIn: () => true,
    });
    const u = await usage.get("cx");
    expect(codex).toHaveBeenCalledWith("/profiles/cx");
    expect(claude).not.toHaveBeenCalled();
    expect(u.limits).toEqual([{ kind: "weekly_all", label: "Weekly (all models)", percent: 12, resetsAt: null }]);
  });

  it("an agent without a fetcher (opencode) is \"unsupported\"", async () => {
    const usage = new UsageService("/profiles", { resolveAgent: () => "opencode", resolveDir, isLoggedIn: () => true });
    const err = await usage.get("oc").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect((err as UsageError).problem).toBe("unsupported");
  });

  // The phone shows what went wrong, not the wire (a 401 body used to land in the app as a wall of JSON)
  it("a fetcher failing with 401 becomes signed_out, with the raw body kept as detail", async () => {
    const raw = 'failed to fetch codex rate limits: GET https://chatgpt.com/backend-api/wham/usage failed: '
      + '401 Unauthorized; body={"error":{"code":"token_invalidated"}}';
    const usage = new UsageService("/profiles", {
      fetchers: { codex: async () => { throw new Error(raw); } },
      resolveAgent: () => "codex", resolveDir, isLoggedIn: () => true,
    });
    const err = await usage.get("cx").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect((err as UsageError).problem).toBe("signed_out");
    expect((err as UsageError).message).toBe("Codex is signed out on your Mac");
    expect((err as UsageError).hint).toBe("tiny profiles login cx");
    expect((err as UsageError).detail).toBe(raw);
  });

  it("any other fetcher failure is \"failed\" and keeps the raw text", async () => {
    const usage = new UsageService("/profiles", {
      fetchers: { claude: async () => { throw new Error("spawn claude ENOENT"); } },
      resolveAgent: () => "claude", resolveDir, isLoggedIn: () => true,
    });
    const err = await usage.get("work").catch((e: unknown) => e);
    expect((err as UsageError).problem).toBe("failed");
    expect((err as UsageError).detail).toBe("spawn claude ENOENT");
    expect((err as UsageError).hint).toBeUndefined();
  });

  describe("classifyUsageError", () => {
    const cases: [string, string][] = [
      ["401 Unauthorized", "signed_out"],
      ['{"code":"token_invalidated"}', "signed_out"],
      ["Your authentication token has been invalidated. Please try signing in again.", "signed_out"],
      ["Not logged in. Run `codex login`", "signed_out"],
      ["usage request timed out after 20000ms", "failed"],
      ["ECONNREFUSED 127.0.0.1:1455", "failed"],
    ];
    it.each(cases)("%s → %s", (raw, problem) => {
      expect(classifyUsageError(new Error(raw), "codex", "cx").problem).toBe(problem);
    });

    it("passes an already-classified error through untouched", () => {
      const original = new UsageError("unavailable", "Usage is not available for this login");
      expect(classifyUsageError(original, "claude", "work")).toBe(original);
    });
  });

  it("the singular fetcher works as an alias for the claude fetcher", async () => {
    const fetcher = vi.fn(async () => RATE_LIMITS);
    const usage = new UsageService("/profiles", { fetcher, resolveAgent: () => "claude", resolveDir, isLoggedIn: () => true });
    await usage.get("work");
    expect(fetcher).toHaveBeenCalledWith("/profiles/work");
  });
});
