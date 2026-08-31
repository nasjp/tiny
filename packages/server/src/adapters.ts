import { AcpAdapter } from "./acp-adapter.js";
import type { AgentAdapter } from "./adapter.js";
import { listDrivers } from "./agents/index.js";
import { ClaudeAdapter } from "./claude-adapter.js";
import { CodexAdapter } from "./codex-adapter.js";

/** Driver id -> adapter that runs its turns. Built once by server.ts at startup */
export function buildAdapters(): Record<string, AgentAdapter> {
  const out: Record<string, AgentAdapter> = {};
  for (const d of listDrivers()) {
    switch (d.adapter) {
      case "claude":
        out[d.id] = new ClaudeAdapter();
        break;
      case "acp":
        out[d.id] = new AcpAdapter(d);
        break;
      case "codex":
        out[d.id] = new CodexAdapter(d);
        break;
      default:
        // Unsupported adapter gets no adapter instance (its turns become turn_failed)
        break;
    }
  }
  return out;
}
