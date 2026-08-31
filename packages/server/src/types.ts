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
