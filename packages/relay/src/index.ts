import { Hono } from "hono";
import { z } from "zod";
import { APNS_PAYLOAD_LIMIT, buildApnsBody, sendApns } from "./apns.js";
import type { Env } from "./env.js";

// deviceToken is the APNs hex token; the length may change in the future, so allow a range.
// payload is base64 sealed by tinyd. collapseId is capped at 64 bytes by APNs.
const pushSchema = z.object({
  deviceToken: z.string().regex(/^[0-9a-fA-F]{64,200}$/),
  apnsEnv: z.enum(["production", "sandbox"]).default("production"),
  payload: z.string().min(1),
  collapseId: z.string().min(1).max(64).optional(),
  priority: z.union([z.literal(10), z.literal(5)]).optional(),
});

const app = new Hono<{ Bindings: Env }>();

app.get("/v1/health", (c) => c.json({ ok: true }));

app.post("/v1/push", async (c) => {
  const json = await c.req.json().catch(() => null);
  const parsed = pushSchema.safeParse(json);
  if (!parsed.success) return c.json({ error: "invalid request" }, 400);
  const input = parsed.data;

  const size = new TextEncoder().encode(buildApnsBody(input.payload)).length;
  if (size > APNS_PAYLOAD_LIMIT) {
    return c.json({ error: `payload too large: ${size} > ${APNS_PAYLOAD_LIMIT}` }, 400);
  }

  const limiter = c.env.PUSH_LIMITER;
  if (limiter) {
    const { success } = await limiter.limit({ key: input.deviceToken });
    if (!success) return c.json({ error: "rate limited" }, 429);
  } else {
    // Self-hosted or wrangler dev may lack the binding. Warn instead of failing.
    console.warn("[relay] PUSH_LIMITER binding is missing (running without rate limiting)");
  }

  try {
    return c.json(await sendApns(c.env, input), 200);
  } catch (err) {
    console.error("[relay] cannot reach APNs:", err);
    return c.json({ error: "apns unreachable" }, 502);
  }
});

export default app;
