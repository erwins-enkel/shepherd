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

test("GET /api/plan-gates/inflight returns in-flight reviews with their reviewer env", async () => {
  const inflight = [
    { id: "sess-1", provider: "claude" as const, model: "opus", effort: "high" },
    { id: "sess-2", provider: null, model: null, effort: null },
  ];
  const { app } = harness({
    planGateCache: { snapshot: () => ({}), reviewing: () => inflight },
  });
  const res = await app.fetch(new Request("http://x/api/plan-gates/inflight"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(inflight);
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

test("POST /api/sessions/:id/review-plan → 202, calls consider, relays status:started", async () => {
  const considered: Session[] = [];
  const { app, store } = harness({
    planGate: {
      consider: async (s: Session) => {
        considered.push(s);
        return "started" as const; // a reviewer was spawned
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
  expect(await res.json()).toEqual({ ok: true, status: "started" });
  expect(considered.length).toBe(1);
  expect(considered[0]!.id).toBe(id);
});

test("POST /api/sessions/:id/review-plan → forwards { force: true } to consider (operator click bypasses dedupe)", async () => {
  const calls: Array<[Session, { force?: boolean } | undefined]> = [];
  const { app, store } = harness({
    planGate: {
      consider: async (s: Session, opts?: { force?: boolean }) => {
        calls.push([s, opts]);
        return "started" as const;
      },
    },
  });
  const seeded = store.create({
    name: "force",
    prompt: "go",
    repoPath: repoDir,
    baseBranch: "main",
    branch: "shepherd/force",
    worktreePath: join(repoDir, "wt-force"),
    isolated: true,
    herdrSession: "sess-force",
    herdrAgentId: "term_force",
    claudeSessionId: "claude-force",
    model: null,
  });
  const res = await app.fetch(
    new Request(`http://x/api/sessions/${seeded.id}/review-plan`, { method: "POST" }),
  );
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ ok: true, status: "started" });
  expect(calls.length).toBe(1);
  expect(calls[0]![0]!.id).toBe(seeded.id);
  expect(calls[0]![1]).toEqual({ force: true });
});

test("POST /api/sessions/:id/review-plan → status:skipped when consider deduped", async () => {
  const { app, store } = harness({
    planGate: {
      consider: async () => "skipped" as const, // unchanged plan / already approved → no-op
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
  expect(await res.json()).toEqual({ ok: true, status: "skipped" });
});

test("POST /api/sessions/:id/review-plan → status:plan-unavailable when no usable plan artifact exists", async () => {
  const { app, store } = harness({
    planGate: {
      consider: async () => "plan-unavailable" as const,
    },
  });
  const seeded = store.create({
    name: "missing plan",
    prompt: "go",
    repoPath: repoDir,
    baseBranch: "main",
    branch: "shepherd/missing-plan",
    worktreePath: join(repoDir, "wt-missing"),
    isolated: true,
    herdrSession: "sess-missing",
    herdrAgentId: "term_missing",
    claudeSessionId: "claude-missing",
    model: null,
  });
  const res = await app.fetch(
    new Request(`http://x/api/sessions/${seeded.id}/review-plan`, { method: "POST" }),
  );
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ ok: true, status: "plan-unavailable" });
});

test("POST /api/sessions/:id/review-plan → 404 for unknown id", async () => {
  let called = false;
  const { app } = harness({
    planGate: {
      consider: async () => {
        called = true;
        return "started" as const;
      },
    },
  });
  const res = await app.fetch(
    new Request("http://x/api/sessions/nope/review-plan", { method: "POST" }),
  );
  expect(res.status).toBe(404);
  expect(called).toBe(false);
});

// ── POST /api/sessions/:id/answer-plan-questions (#803) ─────────────────────

function seedPlanningSession(
  store: SessionStore,
  opts: { suffix: string; phase?: Session["planPhase"]; withForm?: boolean },
): string {
  const seeded = store.create({
    name: "p",
    prompt: "go",
    repoPath: repoDir,
    baseBranch: "main",
    branch: `shepherd/${opts.suffix}`,
    worktreePath: join(repoDir, `wt-${opts.suffix}`),
    isolated: true,
    herdrSession: `sess-${opts.suffix}`,
    herdrAgentId: `term_${opts.suffix}`,
    claudeSessionId: `claude-${opts.suffix}`,
    model: null,
  });
  store.setPlanPhase(seeded.id, opts.phase ?? "planning");
  const gate: PlanGate = {
    sessionId: seeded.id,
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
    blocks: opts.withForm
      ? [
          {
            type: "question-form",
            id: "qf1",
            questions: [
              { id: "q1", prompt: "Which approach?", kind: "single", options: ["Reuse", "New"] },
            ],
          },
        ]
      : [{ type: "rich-text", id: "rt", markdown: "no questions here" }],
  };
  store.putPlanGate(gate);
  return seeded.id;
}

const POST_ANSWERS = (answers: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ answers }),
});

test("POST answer-plan-questions → composes steer, calls reply, returns delivered", async () => {
  const replies: Array<{ id: string; text: string }> = [];
  const store = new SessionStore(":memory:");
  const { app } = (() => {
    const deps: AppDeps = {
      store,
      service: {
        reply: (id: string, text: string) => {
          replies.push({ id, text });
          return true;
        },
      } as any,
      events: new EventHub(),
      usageLimits: { limits: () => ({}) } as any,
    };
    return { app: makeApp(deps) };
  })();
  const id = seedPlanningSession(store, { suffix: "a", withForm: true });
  const res = await app.fetch(
    new Request(
      `http://x/api/sessions/${id}/answer-plan-questions`,
      POST_ANSWERS([{ blockId: "qf1", questionId: "q1", optionIndices: [1] }]),
    ),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, delivered: true });
  expect(replies.length).toBe(1);
  expect(replies[0]!.id).toBe(id);
  expect(replies[0]!.text).toContain("- Which approach?\n  → New");
  expect(replies[0]!.text).toContain("then stop so it can be re-reviewed");
});

test("POST answer-plan-questions → delivered:false when reply can't reach the pane", async () => {
  const store = new SessionStore(":memory:");
  const deps: AppDeps = {
    store,
    service: { reply: () => false } as any,
    events: new EventHub(),
    usageLimits: { limits: () => ({}) } as any,
  };
  const app = makeApp(deps);
  const id = seedPlanningSession(store, { suffix: "b", withForm: true });
  const res = await app.fetch(
    new Request(
      `http://x/api/sessions/${id}/answer-plan-questions`,
      POST_ANSWERS([{ blockId: "qf1", questionId: "q1", optionIndices: [0] }]),
    ),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, delivered: false });
});

test("POST answer-plan-questions → 415 without JSON content-type", async () => {
  const { app, store } = harness();
  const id = seedPlanningSession(store, { suffix: "ct", withForm: true });
  const res = await app.fetch(
    new Request(`http://x/api/sessions/${id}/answer-plan-questions`, {
      method: "POST",
      body: JSON.stringify({ answers: [] }),
    }),
  );
  expect(res.status).toBe(415);
});

test("POST answer-plan-questions → 400 on bad body shape", async () => {
  const { app, store } = harness({ service: { reply: () => true } as any });
  const id = seedPlanningSession(store, { suffix: "shape", withForm: true });
  const res = await app.fetch(
    new Request(
      `http://x/api/sessions/${id}/answer-plan-questions`,
      POST_ANSWERS([{ questionId: "q1" }]), // missing blockId
    ),
  );
  expect(res.status).toBe(400);
});

test("POST answer-plan-questions → 404 for unknown session", async () => {
  const { app } = harness({ service: { reply: () => true } as any });
  const res = await app.fetch(
    new Request(
      "http://x/api/sessions/nope/answer-plan-questions",
      POST_ANSWERS([{ blockId: "qf1", questionId: "q1", optionIndices: [0] }]),
    ),
  );
  expect(res.status).toBe(404);
});

test("POST answer-plan-questions → 409 when session is not in planning phase", async () => {
  let called = false;
  const { app, store } = harness({
    service: {
      reply: () => {
        called = true;
        return true;
      },
    } as any,
  });
  const id = seedPlanningSession(store, { suffix: "exec", phase: "executing", withForm: true });
  const res = await app.fetch(
    new Request(
      `http://x/api/sessions/${id}/answer-plan-questions`,
      POST_ANSWERS([{ blockId: "qf1", questionId: "q1", optionIndices: [0] }]),
    ),
  );
  expect(res.status).toBe(409);
  expect((await res.json()).error).toContain("planning");
  expect(called).toBe(false);
});

test("POST answer-plan-questions → 409 when the gate has no question-form", async () => {
  const { app, store } = harness({ service: { reply: () => true } as any });
  const id = seedPlanningSession(store, { suffix: "noq", withForm: false });
  const res = await app.fetch(
    new Request(
      `http://x/api/sessions/${id}/answer-plan-questions`,
      POST_ANSWERS([{ blockId: "qf1", questionId: "q1", optionIndices: [0] }]),
    ),
  );
  expect(res.status).toBe(409);
  expect((await res.json()).error).toContain("no plan questions");
});

test("POST answer-plan-questions → 400 when nothing resolves", async () => {
  let called = false;
  const { app, store } = harness({
    service: {
      reply: () => {
        called = true;
        return true;
      },
    } as any,
  });
  const id = seedPlanningSession(store, { suffix: "empty", withForm: true });
  const res = await app.fetch(
    new Request(
      `http://x/api/sessions/${id}/answer-plan-questions`,
      POST_ANSWERS([{ blockId: "qf1", questionId: "unknown", optionIndices: [0] }]),
    ),
  );
  expect(res.status).toBe(400);
  expect(called).toBe(false);
});

// ── durable answered-key recording for the ambient tab signal (#1332) ────────

test("POST answer-plan-questions → records the answered key + re-emits the gate (durable clear)", async () => {
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const emitted: Array<{ id: string; gate?: PlanGate }> = [];
  events.subscribe((event, data) => {
    if (event === "session:plangate") emitted.push(data as { id: string; gate?: PlanGate });
  });
  const deps: AppDeps = {
    store,
    service: { reply: () => true } as any,
    events,
    usageLimits: { limits: () => ({}) } as any,
  };
  const app = makeApp(deps);
  const id = seedPlanningSession(store, { suffix: "rec", withForm: true });
  const res = await app.fetch(
    new Request(
      `http://x/api/sessions/${id}/answer-plan-questions`,
      POST_ANSWERS([{ blockId: "qf1", questionId: "q1", optionIndices: [1] }]),
    ),
  );
  expect(res.status).toBe(200);
  // Durable: the resolved key is persisted so the attention signal clears across reconnect.
  expect(store.getPlanGate(id)?.answeredQuestionKeys).toEqual(["qf1 q1"]);
  // Re-emitted so HoldReasonService recomputes + the client store updates.
  expect(emitted.some((e) => e.id === id && e.gate?.answeredQuestionKeys?.includes("qf1 q1"))).toBe(
    true,
  );
});

test("POST answer-plan-questions → a dropped invalid answer records no key (no false-clear)", async () => {
  const { app, store } = harness({ service: { reply: () => true } as any });
  const id = seedPlanningSession(store, { suffix: "drop", withForm: true });
  // q1 is single with 2 options; an out-of-range index is dropped by resolvePlanAnswers.
  const res = await app.fetch(
    new Request(
      `http://x/api/sessions/${id}/answer-plan-questions`,
      POST_ANSWERS([{ blockId: "qf1", questionId: "q1", optionIndices: [99] }]),
    ),
  );
  expect(res.status).toBe(400);
  // The question stays pending: no key was recorded off the dropped answer.
  expect(store.getPlanGate(id)?.answeredQuestionKeys ?? []).toEqual([]);
});

test("POST answer-plan-questions → skips the durable write when a concurrent finalize changed planHash", async () => {
  const store = new SessionStore(":memory:");
  const deps: AppDeps = {
    store,
    service: {
      // Simulate a finalize() landing a fresh gate (new planHash, keys reset) while the steer
      // is in flight — the guard must not clobber it by writing back the stale gate.
      reply: (sid: string) => {
        const g = store.getPlanGate(sid)!;
        store.putPlanGate({ ...g, planHash: "h2", answeredQuestionKeys: [] });
        return true;
      },
    } as any,
    events: new EventHub(),
    usageLimits: { limits: () => ({}) } as any,
  };
  const app = makeApp(deps);
  const id = seedPlanningSession(store, { suffix: "stale", withForm: true });
  const res = await app.fetch(
    new Request(
      `http://x/api/sessions/${id}/answer-plan-questions`,
      POST_ANSWERS([{ blockId: "qf1", questionId: "q1", optionIndices: [1] }]),
    ),
  );
  expect(res.status).toBe(200);
  // The h2 gate written by the concurrent finalize is untouched (no stale key appended).
  expect(store.getPlanGate(id)?.planHash).toBe("h2");
  expect(store.getPlanGate(id)?.answeredQuestionKeys ?? []).toEqual([]);
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
