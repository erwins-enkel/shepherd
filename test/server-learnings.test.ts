import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { config } from "../src/config";
import type { PromoteResult } from "../src/promote";

let tmpRoot: string;
let validRepo: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-learnings-test-"));
  validRepo = join(tmpRoot, "repo");
  mkdirSync(validRepo);
});

afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

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

// ── optimizer routes ─────────────────────────────────────────────────────────

function makeOptimizerDeps(optimizer?: AppDeps["optimizer"]): AppDeps {
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  return {
    store,
    service: {} as any,
    events,
    usageLimits: { limits: () => ({}) } as any,
    optimizer,
  };
}

test("POST /api/learnings/optimize?repo= valid → 200 {ok:true} and calls optimizeAllFlagged", async () => {
  const called: string[] = [];
  const optimizer: AppDeps["optimizer"] = {
    optimizeAllFlagged: (dir) => {
      called.push(dir);
    },
    optimizeOne: () => {},
  };
  const app = makeApp(makeOptimizerDeps(optimizer));

  const res = await app.fetch(
    new Request(`http://x/api/learnings/optimize?repo=${encodeURIComponent(validRepo)}`, {
      method: "POST",
    }),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(called).toHaveLength(1);
});

test("POST /api/learnings/optimize?repo= missing → 400", async () => {
  const optimizer: AppDeps["optimizer"] = {
    optimizeAllFlagged: () => {},
    optimizeOne: () => {},
  };
  const app = makeApp(makeOptimizerDeps(optimizer));

  const res = await app.fetch(
    new Request("http://x/api/learnings/optimize?repo=", { method: "POST" }),
  );
  expect(res.status).toBe(400);
  expect(await res.json()).toHaveProperty("error");
});

test("POST /api/learnings/:id/optimize → 200 {ok:true} and calls optimizeOne", async () => {
  const called: string[] = [];
  const optimizer: AppDeps["optimizer"] = {
    optimizeAllFlagged: () => {},
    optimizeOne: (id) => {
      called.push(id);
    },
  };
  const app = makeApp(makeOptimizerDeps(optimizer));

  const res = await app.fetch(
    new Request("http://x/api/learnings/rule-abc/optimize", { method: "POST" }),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(called).toEqual(["rule-abc"]);
});

// ── GET /api/learnings/health with optimizer ─────────────────────────────────

test("GET /api/learnings/health preserves top-level distiller fields and adds optimizer", async () => {
  const distillerHealth = {
    ok: false,
    consecutiveFailures: 3,
    lastFailure: { reason: "oops", at: 1, repoPath: "/r" },
  };
  const optimizerHealth = { ok: true, consecutiveFailures: 0, lastFailure: null };
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const deps: AppDeps = {
    store,
    service: {} as any,
    events,
    usageLimits: { limits: () => ({}) } as any,
    distiller: { distillNow: () => {}, health: () => distillerHealth },
    optimizer: {
      optimizeAllFlagged: () => {},
      optimizeOne: () => {},
      health: () => optimizerHealth,
    },
  };
  const app = makeApp(deps);

  const res = await app.fetch(new Request("http://x/api/learnings/health"));
  expect(res.status).toBe(200);
  const body = await res.json();
  // top-level distiller fields preserved
  expect(body.ok).toBe(false);
  expect(body.consecutiveFailures).toBe(3);
  expect(body.lastFailure).toEqual(distillerHealth.lastFailure);
  // optimizer sub-object present
  expect(body.optimizer).toEqual(optimizerHealth);
});

test("GET /api/learnings/health without deps → safe defaults with optimizer sub-object", async () => {
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const deps: AppDeps = {
    store,
    service: {} as any,
    events,
    usageLimits: { limits: () => ({}) } as any,
  };
  const app = makeApp(deps);

  const res = await app.fetch(new Request("http://x/api/learnings/health"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.consecutiveFailures).toBe(0);
  expect(body.lastFailure).toBeNull();
  expect(body.optimizer).toBeDefined();
  expect(body.optimizer.ok).toBe(true);
});
