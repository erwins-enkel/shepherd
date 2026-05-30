import type { SessionStore } from "./store";
import type { SessionService } from "./service";
import type { EventHub } from "./events";
import { PtyBridge } from "./pty-bridge";

export interface AppDeps {
  store: SessionStore;
  service: SessionService;
  events: EventHub;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Returns an object with a `fetch(Request)` method — unit-testable without a port. */
export function makeApp(deps: AppDeps) {
  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const parts = url.pathname.split("/").filter(Boolean); // ["api","sessions",":id"]

      if (parts[0] === "api" && parts[1] === "sessions") {
        if (req.method === "POST" && !parts[2]) {
          const input = await req.json();
          const s = await deps.service.create(input);
          deps.events.emit("session:new", s);
          return json(s, 201);
        }
        if (req.method === "GET" && !parts[2]) return json(deps.store.list({ activeOnly: true }));
        if (req.method === "GET" && parts[2]) {
          const s = deps.store.get(parts[2]);
          return s ? json(s) : json({ error: "not found" }, 404);
        }
        if (req.method === "DELETE" && parts[2]) {
          deps.service.archive(parts[2]);
          deps.events.emit("session:archived", { id: parts[2] });
          return json({ ok: true });
        }
      }
      return json({ error: "not found" }, 404);
    },
  };
}

type WsData = { kind: "events" } | { kind: "pty"; terminalId: string; bridge?: PtyBridge };

export function serve(deps: AppDeps, port: number) {
  const app = makeApp(deps);
  return Bun.serve<WsData>({
    port,
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/events") {
        return server.upgrade(req, { data: { kind: "events" } })
          ? undefined
          : new Response("upgrade failed", { status: 500 });
      }
      const m = url.pathname.match(/^\/pty\/([^/]+)$/);
      if (m) {
        const s = deps.store.get(m[1]!);
        if (!s) return new Response("no session", { status: 404 });
        return server.upgrade(req, { data: { kind: "pty", terminalId: s.herdrAgentId } })
          ? undefined
          : new Response("upgrade failed", { status: 500 });
      }
      return app.fetch(req);
    },
    websocket: {
      open(ws) {
        if (ws.data.kind === "events") {
          const unsub = deps.events.subscribe((event, data) =>
            ws.send(JSON.stringify({ event, data })),
          );
          (ws.data as any).unsub = unsub;
        } else {
          const bridge = new PtyBridge(ws.data.terminalId, {
            send: (d) => ws.send(d),
            close: () => ws.close(),
          });
          ws.data.bridge = bridge;
          bridge.open();
        }
      },
      message(ws, msg) {
        if (ws.data.kind !== "pty") return;
        ws.data.bridge?.write(typeof msg === "string" ? msg : msg.toString());
      },
      close(ws) {
        if (ws.data.kind === "events") (ws.data as any).unsub?.();
        else ws.data.bridge?.close();
      },
    },
  });
}
