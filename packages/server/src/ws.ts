import type { Env, Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import type { AuthService } from "./auth.js";
import { bearerFrom } from "./api.js";
import type { SessionManager } from "./session-manager.js";
import type { Stores } from "./stores.js";
import type { EventRecord } from "./types.js";

export interface WsDeps {
  manager: SessionManager;
  auth: AuthService;
  stores: Stores;
}

// The Hono returned by createApp carries Variables, so accept any Env here
export function registerWs<E extends Env>(app: Hono<E>, deps: WsDeps) {
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  app.get(
    "/v1/sessions/:id/stream",
    upgradeWebSocket((c) => {
      const sessionId = c.req.param("id") ?? "";
      const token = bearerFrom(c.req.header("Authorization"), c.req.query("token"));
      const since = Number(c.req.query("since") ?? "0");
      const authorized = deps.auth.verifyBearer(token);
      let listener: ((ev: EventRecord) => void) | null = null;
      return {
        onOpen(_evt, ws) {
          if (!authorized) {
            ws.close(4401, "unauthorized");
            return;
          }
          for (const ev of deps.stores.events.listSince(sessionId, since)) {
            ws.send(JSON.stringify(ev));
          }
          listener = (ev: EventRecord) => {
            if (ev.sessionId === sessionId) ws.send(JSON.stringify(ev));
          };
          deps.manager.on("event", listener);
        },
        onClose() {
          if (listener) deps.manager.off("event", listener);
        },
        onError() {
          if (listener) deps.manager.off("event", listener);
        },
      };
    }),
  );

  return { injectWebSocket };
}
