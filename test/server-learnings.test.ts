import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { config } from "../src/config";
import type { PromoteResult } from "../src/promote";
import { HOUSE_RULES_OVERHEAD } from "../src/house-rules";

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

// ── POST /api/learnings/:id/restore (Task 5) ─────────────────────────────────

function makeBasicDeps(): AppDeps {
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  return {
    store,
    service: {} as any,
    events,
    usageLimits: { limits: () => ({}) } as any,
  };
}

test("POST /api/learnings/:id/restore restores a retired active rule back to active", async () => {
  const deps = makeBasicDeps();
  const app = makeApp(deps);

  const l = deps.store.addLearning({ repoPath: "/r", rule: "rule", rationale: "", evidence: [] });
  deps.store.setLearningStatus(l.id, "active");
  deps.store.retireLearning(l.id, "stale");

  const res = await app.fetch(
    new Request(`http://x/api/learnings/${l.id}/restore`, { method: "POST" }),
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.status).toBe("active");
  expect(body.retiredAt).toBeNull();
  expect(body.retiredReason).toBeNull();
});

test("POST /api/learnings/:id/restore restores a retired promoted rule back to promoted", async () => {
  const deps = makeBasicDeps();
  const app = makeApp(deps);

  const l = deps.store.addLearning({ repoPath: "/r", rule: "rule", rationale: "", evidence: [] });
  deps.store.setLearningStatus(l.id, "active");
  deps.store.setLearningStatus(l.id, "promoted");
  deps.store.retireLearning(l.id, "outdated");

  const res = await app.fetch(
    new Request(`http://x/api/learnings/${l.id}/restore`, { method: "POST" }),
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.status).toBe("promoted");
});

test("POST /api/learnings/:id/restore emits learnings:update", async () => {
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
  };
  const app = makeApp(deps);

  const l = store.addLearning({ repoPath: "/r", rule: "rule", rationale: "", evidence: [] });
  store.setLearningStatus(l.id, "active");
  store.retireLearning(l.id, "stale");

  await app.fetch(new Request(`http://x/api/learnings/${l.id}/restore`, { method: "POST" }));
  expect(emitted.some(([event]) => event === "learnings:update")).toBe(true);
});

test("POST /api/learnings/:id/restore returns 404 for a non-retired (active) rule", async () => {
  const deps = makeBasicDeps();
  const app = makeApp(deps);

  const l = deps.store.addLearning({ repoPath: "/r", rule: "rule", rationale: "", evidence: [] });
  deps.store.setLearningStatus(l.id, "active");

  const res = await app.fetch(
    new Request(`http://x/api/learnings/${l.id}/restore`, { method: "POST" }),
  );
  expect(res.status).toBe(404);
  expect(await res.json()).toHaveProperty("error");
});

test("POST /api/learnings/:id/restore returns 404 for unknown id", async () => {
  const deps = makeBasicDeps();
  const app = makeApp(deps);

  const res = await app.fetch(
    new Request("http://x/api/learnings/no-such-id/restore", { method: "POST" }),
  );
  expect(res.status).toBe(404);
});

// ── GET /api/learnings/injectable — retired + unseenRetired (Task 5) ──────────

test("GET /api/learnings/injectable includes retired and unseenRetired fields", async () => {
  const deps = makeBasicDeps();
  const app = makeApp(deps);

  const l = deps.store.addLearning({
    repoPath: validRepo,
    rule: "rule",
    rationale: "",
    evidence: [],
  });
  deps.store.setLearningStatus(l.id, "active");

  const res = await app.fetch(new Request("http://x/api/learnings/injectable"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.length).toBeGreaterThanOrEqual(1);
  const entry = body.find((e: any) => e.repoPath === validRepo);
  expect(entry).toBeDefined();
  expect(Array.isArray(entry.retired)).toBe(true);
  expect(typeof entry.unseenRetired).toBe("number");
});

test("GET /api/learnings/injectable: a repo whose only rules are retired still appears", async () => {
  const deps = makeBasicDeps();
  const app = makeApp(deps);

  const l = deps.store.addLearning({
    repoPath: validRepo,
    rule: "rule",
    rationale: "",
    evidence: [],
  });
  deps.store.setLearningStatus(l.id, "active");
  deps.store.retireLearning(l.id, "stale");

  const res = await app.fetch(new Request("http://x/api/learnings/injectable"));
  expect(res.status).toBe(200);
  const body = await res.json();
  const entry = body.find((e: any) => e.repoPath === validRepo);
  expect(entry).toBeDefined();
  expect(entry.retired.length).toBe(1);
  expect(entry.rules.length).toBe(0); // no active/promoted rules
});

test("GET /api/learnings/injectable unseenRetired counts retired rules newer than seen marker", async () => {
  const deps = makeBasicDeps();
  const app = makeApp(deps);

  // Mark as "seen" at a time before any rules are retired
  const seenTs = Date.now() - 10000;
  deps.store.markRetiredSeen(validRepo, seenTs);

  const l1 = deps.store.addLearning({
    repoPath: validRepo,
    rule: "r1",
    rationale: "",
    evidence: [],
  });
  deps.store.setLearningStatus(l1.id, "active");
  deps.store.retireLearning(l1.id, "stale");

  const res = await app.fetch(new Request("http://x/api/learnings/injectable"));
  const body = await res.json();
  const entry = body.find((e: any) => e.repoPath === validRepo);
  expect(entry.unseenRetired).toBe(1); // retired after seenTs
});

test("GET /api/learnings/injectable unseenRetired is 0 after POST seen-retired", async () => {
  const deps = makeBasicDeps();
  const app = makeApp(deps);

  const l1 = deps.store.addLearning({
    repoPath: validRepo,
    rule: "r1",
    rationale: "",
    evidence: [],
  });
  deps.store.setLearningStatus(l1.id, "active");
  deps.store.retireLearning(l1.id, "stale");

  // Without seen marker: unseenRetired = 1
  const res1 = await app.fetch(new Request("http://x/api/learnings/injectable"));
  const body1 = await res1.json();
  const entry1 = body1.find((e: any) => e.repoPath === validRepo);
  expect(entry1.unseenRetired).toBe(1);

  // POST seen-retired
  const seenRes = await app.fetch(
    new Request(`http://x/api/learnings/seen-retired?repo=${encodeURIComponent(validRepo)}`, {
      method: "POST",
    }),
  );
  expect(seenRes.status).toBe(200);
  expect(await seenRes.json()).toEqual({ ok: true });

  // Now unseenRetired = 0
  const res2 = await app.fetch(new Request("http://x/api/learnings/injectable"));
  const body2 = await res2.json();
  const entry2 = body2.find((e: any) => e.repoPath === validRepo);
  expect(entry2.unseenRetired).toBe(0);
});

test("GET /api/learnings/injectable: disabled repo also has retired + unseenRetired", async () => {
  const deps = makeBasicDeps();
  const app = makeApp(deps);

  deps.store.setRepoConfig(validRepo, {
    ...deps.store.getRepoConfig(validRepo),
    learningsEnabled: false,
  });

  const l = deps.store.addLearning({
    repoPath: validRepo,
    rule: "rule",
    rationale: "",
    evidence: [],
  });
  deps.store.setLearningStatus(l.id, "active");
  deps.store.retireLearning(l.id, "stale");

  const res = await app.fetch(new Request("http://x/api/learnings/injectable"));
  const body = await res.json();
  const entry = body.find((e: any) => e.repoPath === validRepo);
  expect(entry).toBeDefined();
  expect(Array.isArray(entry.retired)).toBe(true);
  expect(typeof entry.unseenRetired).toBe("number");
  expect(entry.enabled).toBe(false);
});

// ── POST /api/learnings/seen-retired (Task 5) ─────────────────────────────────

test("POST /api/learnings/seen-retired?repo= with missing repo → 400", async () => {
  const deps = makeBasicDeps();
  const app = makeApp(deps);

  const res = await app.fetch(
    new Request("http://x/api/learnings/seen-retired?repo=", { method: "POST" }),
  );
  expect(res.status).toBe(400);
  expect(await res.json()).toHaveProperty("error");
});

// ── PUT /api/repo-config autoOptimizeFlagged (Task 5) ─────────────────────────

test("PUT /api/repo-config accepts autoOptimizeFlagged:true and GET reflects it", async () => {
  const deps = makeBasicDeps();
  const app = makeApp(deps);

  const putRes = await app.fetch(
    new Request(`http://x/api/repo-config?repo=${encodeURIComponent(validRepo)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoOptimizeFlagged: true }),
    }),
  );
  expect(putRes.status).toBe(200);
  const putBody = await putRes.json();
  expect(putBody.autoOptimizeFlagged).toBe(true);

  // GET round-trip
  const getRes = await app.fetch(
    new Request(`http://x/api/repo-config?repo=${encodeURIComponent(validRepo)}`),
  );
  expect(getRes.status).toBe(200);
  const getBody = await getRes.json();
  expect(getBody.autoOptimizeFlagged).toBe(true);
});

test("PUT /api/repo-config with non-boolean autoOptimizeFlagged → 400", async () => {
  const deps = makeBasicDeps();
  const app = makeApp(deps);

  const res = await app.fetch(
    new Request(`http://x/api/repo-config?repo=${encodeURIComponent(validRepo)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoOptimizeFlagged: "yes" }),
    }),
  );
  expect(res.status).toBe(400);
  expect(await res.json()).toHaveProperty("error");
});

test("PUT /api/repo-config autoOptimizeFlagged:false round-trips", async () => {
  const deps = makeBasicDeps();
  const app = makeApp(deps);

  // First set to true
  await app.fetch(
    new Request(`http://x/api/repo-config?repo=${encodeURIComponent(validRepo)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoOptimizeFlagged: true }),
    }),
  );

  // Then set to false
  const putRes = await app.fetch(
    new Request(`http://x/api/repo-config?repo=${encodeURIComponent(validRepo)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoOptimizeFlagged: false }),
    }),
  );
  expect(putRes.status).toBe(200);
  expect((await putRes.json()).autoOptimizeFlagged).toBe(false);
});

// ── #842 scope route + injectable scoped bucket ──────────────────────────────

function harnessWithStore(): {
  app: ReturnType<typeof makeApp>;
  store: SessionStore;
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
  };
  return { app: makeApp(deps), store, emitted };
}

test("POST /api/learnings/:id/scope sets globs, returns the rule, emits update", async () => {
  const { app, store, emitted } = harnessWithStore();
  const l = store.addLearning({ repoPath: "/r", rule: "x", rationale: "", evidence: [] });
  const res = await app.fetch(
    new Request(`http://x/api/learnings/${l.id}/scope`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ globs: ["src/**", "src/**", " ui/** "] }),
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { scopeGlobs: string[] };
  expect(body.scopeGlobs).toEqual(["src/**", "ui/**"]);
  expect(store.getLearning(l.id)!.scopeGlobs).toEqual(["src/**", "ui/**"]);
  expect(emitted.some(([e]) => e === "learnings:update")).toBe(true);
});

test("POST /api/learnings/:id/scope with a bad body clears to [] (Always-rule)", async () => {
  const { app, store } = harnessWithStore();
  const l = store.addLearning({
    repoPath: "/r",
    rule: "x",
    rationale: "",
    evidence: [],
    scopeGlobs: ["src/**"],
  });
  const res = await app.fetch(
    new Request(`http://x/api/learnings/${l.id}/scope`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ globs: "not-an-array" }),
    }),
  );
  expect(res.status).toBe(200);
  expect(store.getLearning(l.id)!.scopeGlobs).toEqual([]);
});

test("POST /api/learnings/:id/scope on a missing rule → 404", async () => {
  const { app } = harnessWithStore();
  const res = await app.fetch(
    new Request("http://x/api/learnings/nope/scope", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ globs: ["src/**"] }),
    }),
  );
  expect(res.status).toBe(404);
});

test("GET /api/learnings/injectable marks scoped rules and excludes them from usedChars", async () => {
  const { app, store } = harnessWithStore();
  // One Always-rule (injects) + one glob-scoped rule (gated in this no-session preview).
  const always = store.addLearning({ repoPath: "/r", rule: "always", rationale: "", evidence: [] });
  store.setLearningStatus(always.id, "active");
  const scoped = store.addLearning({
    repoPath: "/r",
    rule: "scoped",
    rationale: "",
    evidence: [],
    scopeGlobs: ["src/**"],
  });
  store.setLearningStatus(scoped.id, "active");

  const res = await app.fetch(new Request("http://x/api/learnings/injectable"));
  expect(res.status).toBe(200);
  const out = (await res.json()) as {
    repoPath: string;
    usedChars: number;
    rules: { id: string; injected: boolean; scoped: boolean }[];
  }[];
  const repo = out.find((r) => r.repoPath === "/r")!;
  const byId = Object.fromEntries(repo.rules.map((r) => [r.id, r]));
  expect(byId[always.id]!.injected).toBe(true);
  expect(byId[always.id]!.scoped).toBe(false);
  // scoped rule: not injected, flagged scoped (NOT over-budget)
  expect(byId[scoped.id]!.injected).toBe(false);
  expect(byId[scoped.id]!.scoped).toBe(true);
  // usedChars reflects the Always-rule only — the scoped rule never counts against budget.
  const alwaysCost = ("- " + "always" + "\n").length;
  expect(repo.usedChars).toBe(alwaysCost + HOUSE_RULES_OVERHEAD);
});
