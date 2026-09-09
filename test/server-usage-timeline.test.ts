import { test, expect } from "bun:test";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { USAGE_TIMELINE_KEYS, USAGE_TIMELINE_HOUR_KEYS } from "../src/types";
import type { SessionUsageSnapshot } from "../src/types";

function harness(): { app: ReturnType<typeof makeApp>; store: SessionStore } {
  const store = new SessionStore(":memory:");
  const deps: AppDeps = {
    store,
    service: {} as any,
    events: new EventHub(),
    usageLimits: { limits: () => ({}) } as any,
  };
  return { app: makeApp(deps), store };
}

function exactKeys(obj: object, keys: readonly string[]): void {
  expect(Object.keys(obj).sort()).toEqual([...keys].sort());
}

const NOW = Date.now();
const HOUR = 3_600_000;

function seedHour(store: SessionStore, sessionId: string, units: number): number {
  const hour = NOW - HOUR - ((NOW - HOUR) % HOUR);
  const snap: SessionUsageSnapshot = {
    sessionId,
    desig: "TASK-01",
    name: "feat",
    repoPath: "/repos/x",
    model: "claude-opus-4-8",
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    total: 2,
    weightedUnits: units,
    cacheReadUnits: 0,
    messageCount: 1,
    byModel: { "claude-opus-4-8": units },
    rawByModel: { "claude-opus-4-8": 2 },
    createdAt: NOW - 2 * HOUR,
    archivedAt: NOW - 500,
    snapshotAt: NOW - 500,
  };
  store.upsertSessionUsage(snap);
  store.replaceSessionUsageBuckets(sessionId, [
    {
      sessionId,
      bucketStart: hour,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      weightedUnits: units,
      cacheReadUnits: 0,
      byModel: { "claude-opus-4-8": units },
      rawByModel: { "claude-opus-4-8": 0 },
    },
  ]);
  return hour;
}

test("GET /api/usage/timeline?range=7d → 200 with correct shape", async () => {
  const { app, store } = harness();
  const hour = seedHour(store, "sess-1", 0.5);

  const res = await app.fetch(new Request("http://x/api/usage/timeline?range=7d"));
  expect(res.status).toBe(200);

  const body = await res.json();
  exactKeys(body, USAGE_TIMELINE_KEYS);
  expect(body.range).toBe("7d");
  expect(Array.isArray(body.hours)).toBe(true);
  expect(body.hours).toHaveLength(1);
  exactKeys(body.hours[0], USAGE_TIMELINE_HOUR_KEYS);
  expect(body.hours[0].hourStart).toBe(hour);
  expect(body.hours[0].units).toBeCloseTo(0.5, 9);
  expect(body.totalUnits).toBeCloseTo(0.5, 9);
  expect(body.peakHourUnits).toBeCloseTo(0.5, 9);
});

test("GET /api/usage/timeline (no range) → defaults to 7d", async () => {
  const { app } = harness();
  const res = await app.fetch(new Request("http://x/api/usage/timeline"));
  expect(res.status).toBe(200);
  expect((await res.json()).range).toBe("7d");
});

test("GET /api/usage/timeline?range=bogus → 400", async () => {
  const { app } = harness();
  const res = await app.fetch(new Request("http://x/api/usage/timeline?range=bogus"));
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("invalid range");
});
