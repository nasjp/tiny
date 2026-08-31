import { expect } from "vitest";
import type { TurnEventInput } from "../src/adapter.js";

/**
 * Adapter contract: every agent adapter (Claude / ACP / Codex) must emit, per turn,
 * an event sequence satisfying these invariants. Called from each adapter's tests.
 * - First event is turn_started (with agentSessionId)
 * - tool_started carries toolUseId / toolName / kind / summary, and a tool_finished with the same toolUseId follows
 * - Exactly one terminal event, either turn_completed or turn_failed, and it comes last
 */
export function assertTurnEventInvariants(events: TurnEventInput[]): void {
  expect(events.length).toBeGreaterThan(0);
  expect(events[0]!.type).toBe("turn_started");
  expect(typeof events[0]!.payload.agentSessionId).toBe("string");

  const finished = new Set<string>();
  for (const ev of events) {
    if (ev.type === "tool_finished") finished.add(String(ev.payload.toolUseId));
  }
  for (const ev of events) {
    if (ev.type !== "tool_started") continue;
    expect(typeof ev.payload.toolUseId).toBe("string");
    expect(typeof ev.payload.toolName).toBe("string");
    expect(typeof ev.payload.kind).toBe("string");
    expect(typeof ev.payload.summary).toBe("string");
    expect(finished.has(String(ev.payload.toolUseId))).toBe(true);
  }

  const terminals = events.filter((e) => e.type === "turn_completed" || e.type === "turn_failed");
  expect(terminals).toHaveLength(1);
  expect(events[events.length - 1]!.type).toBe(terminals[0]!.type);
}
