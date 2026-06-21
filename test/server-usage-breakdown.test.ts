import { test, expect } from "bun:test";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import {
  USAGE_BREAKDOWN_KEYS,
  USAGE_REPO_KEYS,
  USAGE_TASK_KEYS,
  USAGE_TOKENS_KEYS,
} from "../src/types";
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
  const actual = Object.keys(obj).sort();
  const expected = [...keys].sort();
  expect(actual).toEqual(expected);
}

const NOW = Date.now();

function seedSnapshot(store: SessionStore, overrides: Partial<SessionUsageSnapshot> = {}): void {
  const snap: SessionUsageSnapshot = {
    sessionId: "sess-usage-1",
    desig: "TASK-01",
    repoPath: "/home/user/repos/my-project",
    model: "claude-sonnet-4",
    input: 1000,
    output: 500,
    cacheRead: 2000,
    cacheWrite: 100,
    total: 3600,
    weightedUnits: 0.05,
    cacheReadUnits: 0.01,
    messageCount: 10,
    byModel: { "claude-sonnet-4": 0.05 },
    createdAt: NOW - 1000,
    archivedAt: NOW - 500,
    snapshotAt: NOW - 100,
    ...overrides,
  };
  store.upsertSessionUsage(snap);
}

// ── GET /api/usage/breakdown ──────────────────────────────────────────────────

test("GET /api/usage/breakdown?range=7d → 200 with correct shape", async () => {
  const { app, store } = harness();
  seedSnapshot(store);

  const res = await app.fetch(new Request("http://x/api/usage/breakdown?range=7d"));
  expect(res.status).toBe(200);

  const body = await res.json();
  exactKeys(body, USAGE_BREAKDOWN_KEYS);
  expect(body.range).toBe("7d");

  for (const repo of body.repos) {
    exactKeys(repo, USAGE_REPO_KEYS);
    for (const task of repo.tasks) {
      exactKeys(task, USAGE_TASK_KEYS);
      exactKeys(task.tokens, USAGE_TOKENS_KEYS);
    }
  }
});

test("GET /api/usage/breakdown (no range) → 200 with range=7d default", async () => {
  const { app, store } = harness();
  seedSnapshot(store);

  const res = await app.fetch(new Request("http://x/api/usage/breakdown"));
  expect(res.status).toBe(200);

  const body = await res.json();
  expect(body.range).toBe("7d");
});

test("GET /api/usage/breakdown?range=bogus → 400", async () => {
  const { app } = harness();

  const res = await app.fetch(new Request("http://x/api/usage/breakdown?range=bogus"));
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toBe("invalid range");
});
