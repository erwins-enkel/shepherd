import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { config } from "../src/config";
import type { Session, PlanGate } from "../src/types";

let tmpRoot: string;
let repoDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-plangate-test-"));
  repoDir = join(tmpRoot, "repo");
  mkdirSync(repoDir);
});
afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

// A minimal store-backed harness with stub service + planGate so each route's wiring
// is exercised in isolation. Pass overrides to inject spies for the assertions.
function harness(over: Partial<AppDeps> = {}): {
  app: ReturnType<typeof makeApp>;
  store: SessionStore;
} {
  const store = new SessionStore(":memory:");
  const deps: AppDeps = {
    store,
    service: {} as any,
    events: new EventHub(),
    usageLimits: { limits: () => ({}) } as any,
    ...over,
  };
  return { app: makeApp(deps), store };
}

// ── GET /api/plan-gates ─────────────────────────────────────────────────────

test("GET /api/plan-gates returns the snapshot when planGateCache is present", async () => {
  const gate: PlanGate = {
    sessionId: "sess-1",
    planHash: "h",
    decision: "approved",
    summary: "ok",
    body: "",
    findings: [],
    round: 0,
    cap: 3,
    approved: true,
    plan: "the plan",
    updatedAt: 1000,
  };
  const { app } = harness({ planGateCache: { snapshot: () => ({ "sess-1": gate }) } });
  const res = await app.fetch(new Request("http://x/api/plan-gates"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ "sess-1": gate });
});

test("GET /api/plan-gates returns {} when planGateCache is absent", async () => {
  const { app } = harness();
  const res = await app.fetch(new Request("http://x/api/plan-gates"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({});
});

test("GET /api/plan-gates/inflight returns in-flight session ids", async () => {
  const { app } = harness({
    planGateCache: { snapshot: () => ({}), reviewing: () => ["sess-1", "sess-2"] },
  });
  const res = await app.fetch(new Request("http://x/api/plan-gates/inflight"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(["sess-1", "sess-2"]);
});

test("GET /api/plan-gates/inflight returns [] when planGateCache is absent", async () => {
  const { app } = harness();
  const res = await app.fetch(new Request("http://x/api/plan-gates/inflight"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual([]);
});

// ── POST /api/sessions/:id/go ───────────────────────────────────────────────

test("POST /api/sessions/:id/go → 200 when releasePlanGate returns true", async () => {
  const calls: string[] = [];
  const { app } = harness({
    service: {
      releasePlanGate: (id: string) => {
        calls.push(id);
        return true;
      },
    } as any,
  });
  const res = await app.fetch(new Request("http://x/api/sessions/sess-1/go", { method: "POST" }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(calls).toEqual(["sess-1"]);
});

test("POST /api/sessions/:id/go → 409 when releasePlanGate returns false", async () => {
  const { app } = harness({
    service: { releasePlanGate: () => false } as any,
  });
  const res = await app.fetch(new Request("http://x/api/sessions/sess-1/go", { method: "POST" }));
  expect(res.status).toBe(409);
  expect((await res.json()).error).toContain("not approved");
});

// ── POST /api/sessions/:id/review-plan ──────────────────────────────────────

test("POST /api/sessions/:id/review-plan → 202, calls consider, relays started:true", async () => {
  const considered: Session[] = [];
  const { app, store } = harness({
    planGate: {
      consider: async (s: Session) => {
        considered.push(s);
        return true; // a reviewer was spawned
      },
    },
  });
  // seed a real session so store.get(id) resolves
  const seeded = store.create({
    name: "x",
    prompt: "go",
    repoPath: repoDir,
    baseBranch: "main",
    branch: "shepherd/x",
    worktreePath: join(repoDir, "wt"),
    isolated: true,
    herdrSession: "sess-x",
    herdrAgentId: "term_x",
    claudeSessionId: "claude-x",
    model: null,
  });
  const id = seeded.id;
  const res = await app.fetch(
    new Request(`http://x/api/sessions/${id}/review-plan`, { method: "POST" }),
  );
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ ok: true, started: true });
  expect(considered.length).toBe(1);
  expect(considered[0]!.id).toBe(id);
});

test("POST /api/sessions/:id/review-plan → started:false when consider deduped", async () => {
  const { app, store } = harness({
    planGate: {
      consider: async () => false, // unchanged plan / already approved → no-op
    },
  });
  const seeded = store.create({
    name: "y",
    prompt: "go",
    repoPath: repoDir,
    baseBranch: "main",
    branch: "shepherd/y",
    worktreePath: join(repoDir, "wt2"),
    isolated: true,
    herdrSession: "sess-y",
    herdrAgentId: "term_y",
    claudeSessionId: "claude-y",
    model: null,
  });
  const res = await app.fetch(
    new Request(`http://x/api/sessions/${seeded.id}/review-plan`, { method: "POST" }),
  );
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ ok: true, started: false });
});

test("POST /api/sessions/:id/review-plan → 404 for unknown id", async () => {
  let called = false;
  const { app } = harness({
    planGate: {
      consider: async () => {
        called = true;
        return true;
      },
    },
  });
  const res = await app.fetch(
    new Request("http://x/api/sessions/nope/review-plan", { method: "POST" }),
  );
  expect(res.status).toBe(404);
  expect(called).toBe(false);
});

// ── PUT /api/repo-config { planGateEnabled } (regression guard for Task 2 wiring) ──

test("PUT /api/repo-config persists + echoes planGateEnabled=true", async () => {
  const { app } = harness();
  const url = `http://x/api/repo-config?repo=${encodeURIComponent(repoDir)}`;
  const put = await app.fetch(
    new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planGateEnabled: true }),
    }),
  );
  expect(put.status).toBe(200);
  expect((await put.json()).planGateEnabled).toBe(true);

  const get = await app.fetch(new Request(url));
  expect((await get.json()).planGateEnabled).toBe(true);
});
