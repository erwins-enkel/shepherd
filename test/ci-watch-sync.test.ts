// ci-watch lifecycle sync (#2542): close on green before claim, never after, ≤ 10 per poll.

import { test, expect, beforeEach } from "bun:test";
import { mapKey, type FiledIssue, type KeyRecord } from "../src/plugins/bundled/ci-watch/state";
import { GREEN_COMMENT, MAX_SYNC, syncFiled } from "../src/plugins/bundled/ci-watch/sync";
import type { PluginIssue, PluginSessionSnapshot, PluginState } from "../src/plugins/types";

function memState(): PluginState {
  const m = new Map<string, string>();
  return {
    get: <T>(k: string) => (m.has(k) ? (JSON.parse(m.get(k)!) as T) : null),
    set: (k, v) => void m.set(k, JSON.stringify(v ?? null)),
    delete: (k) => void m.delete(k),
    keys: () => [...m.keys()],
  };
}

const REPO = "/r/web";
const WF = ".github/workflows/ci.yml";
let state: PluginState;
let issues: Map<number, PluginIssue | null>;
let closed: Array<{ number: number; comment?: string }>;
let gets: number[];
let sessions: PluginSessionSnapshot[];

function seed(
  job: string,
  number: number,
  over: Partial<KeyRecord> = {},
  f: Partial<FiledIssue> = {},
) {
  const key = mapKey(REPO, WF, job);
  state.set(key, {
    repo: REPO,
    workflowName: "CI",
    workflowFile: WF,
    job,
    streak: 0,
    lastRunId: 8,
    lastConclusion: "success",
    filed: { number, url: `u${number}`, filedAt: "t", runId: 7, attempts: 1, sync: "open", ...f },
    ...over,
  } satisfies KeyRecord);
  issues.set(number, {
    number,
    title: "t",
    body: "",
    url: `u${number}`,
    labels: ["ci-failure"],
    state: "open",
  });
  return key;
}

const filed = (key: string) => state.get<KeyRecord>(key)!.filed!;

function sync() {
  return syncFiled({
    state,
    issues: {
      get: async (_repo, n) => (gets.push(n), issues.get(n) ?? null),
      close: async (_repo, number, comment) => {
        closed.push({ number, comment });
        const i = issues.get(number);
        if (i) issues.set(number, { ...i, state: "closed" });
      },
    },
    sessions: { list: () => sessions },
    now: () => new Date(1000),
    log: { log: () => {}, warn: () => {} },
  });
}

beforeEach(() => {
  state = memState();
  issues = new Map();
  closed = [];
  gets = [];
  sessions = [];
});

test("unclaimed + green since the filed run → closed with a comment", async () => {
  const key = seed("test", 3);
  expect(await sync()).toEqual({ "sync-closed-green": 1 });
  expect(closed).toEqual([{ number: 3, comment: GREEN_COMMENT }]);
  expect(filed(key)).toMatchObject({ sync: "closed", closedReason: "green", syncedAt: 1000 });
  expect(await sync()).toEqual({});
});

test("still red → left open", async () => {
  const key = seed("test", 3, { lastRunId: 9, lastConclusion: "failure" });
  expect(await sync()).toEqual({ "sync-open": 1 });
  expect(closed).toEqual([]);
  expect(filed(key).sync).toBe("open");
});

test("claimed by a session → never closed, even when green", async () => {
  seed("test", 3);
  sessions = [{ repoPath: REPO, issueNumber: 3, createdAt: 1 } as PluginSessionSnapshot];
  expect(await sync()).toEqual({ "sync-claimed": 1 });
  expect(await sync()).toEqual({ "sync-claimed": 1 });
  expect(closed).toEqual([]);
});

test("claimed via the drain's claim label → never closed", async () => {
  seed("test", 3);
  issues.set(3, { ...issues.get(3)!, labels: ["ci-failure", "shepherd:active"] });
  expect(await sync()).toEqual({ "sync-claimed": 1 });
  expect(closed).toEqual([]);
});

test("a session in another repo with the same number doesn't count as a claim", async () => {
  seed("test", 3);
  sessions = [{ repoPath: "/r/other", issueNumber: 3, createdAt: 1 } as PluginSessionSnapshot];
  expect(await sync()).toEqual({ "sync-closed-green": 1 });
});

test("closed on the forge → stops syncing; unreadable → retried", async () => {
  const a = seed("a", 3);
  issues.set(3, { ...issues.get(3)!, state: "closed" });
  const b = seed("b", 4, { lastConclusion: "failure" });
  issues.set(4, null);
  expect(await sync()).toEqual({ "sync-gh-closed": 1, "sync-gh-unavailable": 1 });
  expect(filed(a).sync).toBe("closed");
  expect(filed(b).sync).toBe("open");
  expect(closed).toEqual([]);
});

test(`at most ${MAX_SYNC} records per pass, least recently synced first`, async () => {
  for (let i = 0; i < 12; i++) {
    seed(`j${i}`, 100 + i, { lastConclusion: "failure" }, { syncedAt: i < 2 ? 500 : i });
  }
  await sync();
  expect(gets).toHaveLength(MAX_SYNC);
  expect(gets).not.toContain(100);
  expect(gets).not.toContain(101);
  gets = [];
  await sync(); // the synced ten now carry syncedAt 1000 > 500
  expect(gets.slice(0, 2)).toEqual([100, 101]);
});

test("a close error is counted and the record stays open", async () => {
  const key = seed("test", 3);
  const r = await syncFiled({
    state,
    issues: {
      get: async () => issues.get(3)!,
      close: async () => {
        throw new Error("403");
      },
    },
    sessions: { list: () => [] },
    now: () => new Date(1000),
    log: { log: () => {}, warn: () => {} },
  });
  expect(r).toEqual({ "sync-error": 1 });
  expect(filed(key).sync).toBe("open");
});
