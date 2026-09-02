import { test, expect } from "bun:test";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";

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

const NOW = Date.now();

function seedMerged(store: SessionStore, id: string): void {
  store.upsertDeliveryFact({
    sessionId: id,
    repoPath: "/repos/alpha",
    desig: "TASK-01",
    issueNumber: 5,
    prNumber: 9,
    createdAt: NOW - 7_200_000,
    prOpenedAt: NOW - 3_600_000,
    mergedAt: NOW - 600_000,
    firstCiHeadSha: "abc123",
    firstCiConclusion: "success",
    now: NOW,
  });
  store.recordReviewerSpawn({
    reviewerSessionId: `${id}-rev`,
    taskSessionId: id,
    kind: "review",
    worktreePath: "/wt",
    model: null,
    spawnedAt: NOW - 3_000_000,
  });
  store.setReviewerSpawnOutcome(`${id}-rev`, "clean", "minor");
}

test("GET /api/usage/delivery?range=7d → 200 with the full indicator set", async () => {
  const { app, store } = harness();
  seedMerged(store, "sess-1");

  const res = await app.fetch(new Request("http://x/api/usage/delivery?range=7d"));
  expect(res.status).toBe(200);
  const body = await res.json();

  expect(body.range).toBe("7d");
  expect(body.since).toBeGreaterThan(0);
  expect(body.measuringSince).toBe(NOW - 7_200_000);
  expect(body.totals.mergedTasks).toBe(1);
  expect(body.totals.firstPassRate).toEqual({ value: 1, n: 1 });
  expect(body.totals.leadTimeMs.value).toBe(6_600_000);
  expect(body.totals.timeToFirstReviewMs.value).toBe(600_000);
  // #2155: the drift measurement travels with the rest of the indicator set.
  expect(body.totals.planDriftRate).toEqual({ value: 1, n: 1 });
  expect(body.totals.planDriftMajor).toBe(0);
  // #2159: the retained first-push CI conclusion travels with it.
  expect(body.totals.firstPushGreenRate).toEqual({ value: 1, n: 1 });
  expect(body.repos[0].repo).toBe("alpha");
  expect(body.tasks[0].desig).toBe("TASK-01");
  expect(Array.isArray(body.incidents)).toBe(true);
  expect(Array.isArray(body.trend)).toBe(true);
});

test("GET /api/usage/delivery (no range) defaults to 7d", async () => {
  const { app } = harness();
  const res = await app.fetch(new Request("http://x/api/usage/delivery"));
  expect(res.status).toBe(200);
  expect((await res.json()).range).toBe("7d");
});

test("GET /api/usage/delivery?range=all → since 0", async () => {
  const { app } = harness();
  const res = await app.fetch(new Request("http://x/api/usage/delivery?range=all"));
  expect(res.status).toBe(200);
  expect((await res.json()).since).toBe(0);
});

test("GET /api/usage/delivery?range=bogus → 400", async () => {
  const { app } = harness();
  const res = await app.fetch(new Request("http://x/api/usage/delivery?range=bogus"));
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("invalid range");
});

test("empty install returns nulls, not zeros", async () => {
  const { app } = harness();
  const res = await app.fetch(new Request("http://x/api/usage/delivery"));
  const body = await res.json();
  expect(body.measuringSince).toBeNull();
  expect(body.totals.firstPassRate.value).toBeNull();
  expect(body.totals.leadTimeMs.value).toBeNull();
  expect(body.totals.planDriftRate.value).toBeNull();
  expect(body.totals.firstPushGreenRate.value).toBeNull();
});

// ── maintain loop block (#2157) ──────────────────────────────────────────────

const READING = {
  key: "critic_error_rate",
  bandId: "critic_error_rate" as const,
  repoPath: null,
  subject: null,
  tier: 2 as const,
  value: 0.4,
  sampleN: 20,
  belowMinSample: false,
  evaluatedAt: NOW,
};

test("the delivery payload always carries a maintain block", async () => {
  // SHEPHERD_MAINTAIN_LOOP is off in tests, so this is the default-off contract the lens renders.
  const { app } = harness();
  const res = await app.fetch(new Request("http://x/api/usage/delivery"));
  const body = await res.json();
  expect(body.maintain).toEqual({
    enabled: false,
    act: false,
    pr: false,
    readings: [],
    recentRuns: [],
  });
});

test("a wired maintain service surfaces its readings on the delivery payload", async () => {
  const { app } = harness({
    maintain: { sweep: async () => {}, snapshot: () => ({ readings: [READING], recentRuns: [] }) },
  });
  const res = await app.fetch(new Request("http://x/api/usage/delivery"));
  const body = await res.json();
  expect(body.maintain.readings).toHaveLength(1);
  expect(body.maintain.readings[0].key).toBe("critic_error_rate");
  // The block is additive — the R1 indicators are untouched beside it.
  expect(body.totals).toBeDefined();
});

test("POST /api/maintain/sweep 404s while the feature flag is off", async () => {
  let swept = false;
  const { app } = harness({
    maintain: {
      sweep: async () => {
        swept = true;
      },
      snapshot: () => ({ readings: [], recentRuns: [] }),
    },
  });
  const res = await app.fetch(new Request("http://x/api/maintain/sweep", { method: "POST" }));
  expect(res.status).toBe(404);
  expect(swept).toBe(false);
});
