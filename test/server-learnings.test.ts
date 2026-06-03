import { test, expect } from "bun:test";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import type { PromoteResult } from "../src/promote";

function harness(promoter?: AppDeps["promoter"]): {
  app: ReturnType<typeof makeApp>;
  emitted: Array<[string, unknown]>;
} {
  const store = new SessionStore(":memory:");
  const emitted: Array<[string, unknown]> = [];
  const events = new EventHub();
  const origEmit = events.emit.bind(events);
  events.emit = (event: string, data: unknown) => {
    emitted.push([event, data]);
    return origEmit(event, data);
  };
  const deps: AppDeps = {
    store,
    service: {} as any,
    events,
    usageLimits: { limits: () => ({}) } as any,
    promoter,
  };
  return { app: makeApp(deps), emitted };
}

// ── POST /api/learnings/:id/promote ──────────────────────────────────────────

test("promote success → 200 with url and emits learnings:update", async () => {
  const stub: AppDeps["promoter"] = {
    promote: async (): Promise<PromoteResult> => ({ ok: true, url: "https://pr/7" }),
  };
  const { app, emitted } = harness(stub);

  const res = await app.fetch(
    new Request("http://x/api/learnings/abc123/promote", { method: "POST" }),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ url: "https://pr/7" });
  expect(emitted.some(([event]) => event === "learnings:update")).toBe(true);
});

test("promote error → propagates status code from service", async () => {
  const stub: AppDeps["promoter"] = {
    promote: async (): Promise<PromoteResult> => ({
      ok: false,
      error: "only active rules can be promoted",
      status: 409,
    }),
  };
  const { app } = harness(stub);

  const res = await app.fetch(
    new Request("http://x/api/learnings/abc123/promote", { method: "POST" }),
  );
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body).toHaveProperty("error");
});

test("promote with no promoter dep → 503", async () => {
  const { app } = harness(undefined);

  const res = await app.fetch(
    new Request("http://x/api/learnings/abc123/promote", { method: "POST" }),
  );
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ error: "promote unavailable" });
});
