import crypto from "node:crypto";
import type { ToolHint } from "./tool-kinds.js";

// updatedInput is the hook for tools like AskUserQuestion that write the response back into the input.
// When omitted, the original input is allowed as-is (claude-adapter fills it in)
export type PermissionDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string };

export interface PendingPermission {
  id: string;
  sessionId: string;
  toolName: string;
  input: unknown;
  requestedAt: string;
  /** Display hint (same vocabulary as tool_started). Present only when the adapter set it */
  kind?: string;
  summary?: string;
}

interface Entry {
  info: PendingPermission;
  resolve: (d: PermissionDecision) => void;
  timer: NodeJS.Timeout;
}

export class PermissionBroker {
  private pendings = new Map<string, Entry>();

  constructor(private timeoutMs: number = 10 * 60 * 1000) {}

  request(
    sessionId: string,
    toolName: string,
    input: unknown,
    hint?: ToolHint,
  ): { id: string; decision: Promise<PermissionDecision> } {
    const id = crypto.randomUUID();
    const info: PendingPermission = {
      id, sessionId, toolName, input, requestedAt: new Date().toISOString(),
      ...(hint ? { kind: hint.kind, summary: hint.summary } : {}),
    };
    const decision = new Promise<PermissionDecision>((resolvePromise) => {
      const timer = setTimeout(() => {
        this.pendings.delete(id);
        resolvePromise({ behavior: "deny", message: "timeout" });
      }, this.timeoutMs);
      timer.unref?.();
      this.pendings.set(id, { info, resolve: resolvePromise, timer });
    });
    return { id, decision };
  }

  resolve(id: string, decision: PermissionDecision): boolean {
    const e = this.pendings.get(id);
    if (!e) return false;
    clearTimeout(e.timer);
    this.pendings.delete(id);
    e.resolve(decision);
    return true;
  }

  listPending(sessionId: string): PendingPermission[] {
    return [...this.pendings.values()].filter((e) => e.info.sessionId === sessionId).map((e) => e.info);
  }
}
