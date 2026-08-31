import type { TranscriptEvent } from "./claude-transcript.js";

/**
 * Shared shapes for reading an agent's OWN session storage (sessions the person started in the
 * terminal, which tiny can only observe). Implementations live in codex-live.ts / opencode-live.ts
 * — the same isolation rule as claude-peer.ts: undocumented interfaces are read in exactly one
 * module per agent, everything degrades to null / empty, and tiny never writes there.
 */

/** A session found in the agent's storage */
export interface ExternalSession {
  agentSessionId: string;
  cwd: string;
  /** When the session started (ISO 8601), null when the storage does not say */
  startedAt: string | null;
  /** Something the person actually said (or the agent's own title). null = nothing yet — do not adopt */
  title: string | null;
}

/** The newest turn's state, as far as the storage shows */
export interface ExternalTurn {
  startedAt: string | null;
  outputTokens: number | null;
  /** true while the turn has started but not completed in the storage */
  open: boolean;
}

/** One incremental read of a session's history */
export interface ExternalRead {
  events: TranscriptEvent[];
  /** Pass back as sinceCursor next time. Opaque, per-agent format */
  cursor: string;
  turn: ExternalTurn | null;
  title: string | null;
}
