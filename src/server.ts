import type { SessionStore } from "./store";
import type { SessionService } from "./service";
import type { EventHub } from "./events";

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
