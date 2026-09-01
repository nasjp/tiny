export type SessionStatus = "idle" | "running" | "detached" | "interrupted";
/** Permission mode. The value set is per-agent (driver capabilities.permissionModes), hence a plain string */
export type PermissionModeValue = string;

export interface SessionRecord {
  id: string;
  agentSessionId: string | null;
  /** Agent id (determined by the profile's driver) */
  agent: string;
  profile: string;
  cwd: string;
  permissionMode: PermissionModeValue;
  /** claude model alias (sonnet/opus/haiku etc.). null follows the CLI default */
  model: string | null;
  /** Reasoning effort (low/medium/high/xhigh/max). null means default */
  effort: string | null;
  title: string | null;
  status: SessionStatus;
  /** Archive time (ISO). null means shown normally. Only affects list filtering */
  archivedAt: string | null;
  /** Last transcript record uuid imported from the agent's own history. null = nothing imported */
  sourceCursor: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EventRecord {
  id: number;
  sessionId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type ApnsEnv = "production" | "sandbox";

export interface DeviceRecord {
  id: string;
  name: string;
  bearerToken: string;
  apnsToken: string | null;
  /** Environment the device token was issued in. Dev builds use sandbox; TestFlight/App Store use production. */
  apnsEnv: ApnsEnv;
  e2eKey: string;
  createdAt: string;
}

export interface FileRecord {
  id: string;
  sessionId: string;
  originalPath: string;
  storedPath: string;
  mime: string;
  caption: string | null;
  createdAt: string;
}

/**
 * What a session is doing right now, whichever side started the work — a turn tiny runs, a turn
 * it handed to the CLI, or a turn the person typed into the CLI themselves. Runtime-only: nothing
 * here is persisted, so it is exactly as fresh as the last poll
 */
export interface SessionActivity {
  /** When the current work started (ISO 8601). null when nothing says */
  since: string | null;
  /** Output tokens the agent has produced so far in this turn. null when unknown */
  outputTokens: number | null;
  /**
   * "background": the CLI's own turn has ended, but a shell task it started in the background is
   * still running and it will pick up again when that finishes (registry status "shell"). Absent
   * for an ordinary turn
   */
  reason?: "background";
}

/** What the API returns for a session: the record plus runtime-only fields */
export interface SessionResponse extends SessionRecord {
  /** true = the agent's own CLI still has this session open. null = could not tell */
  cliLive: boolean | null;
  /** true = a turn sent now runs inside that CLI (live join) instead of being refused with 409 */
  cliJoin: boolean;
  /** The turn in progress (from either side), or null when the session is idle */
  activity: SessionActivity | null;
}
