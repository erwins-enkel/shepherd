import { test, expect } from "vitest";
import { HerdStore } from "../src/lib/store.svelte";
import type { Session } from "../src/lib/types";

const s = (id: string, status: any = "running"): Session => ({
  id,
  desig: "TASK-01",
  name: "x",
  prompt: "x",
  repoPath: "/r",
  baseBranch: "main",
  branch: "shepherd/x",
  worktreePath: "/wt",
  isolated: true,
  herdrSession: "default",
  herdrAgentId: "term_" + id,
  claudeSessionId: "cs-" + id,
  model: null,
  status,
  readyToMerge: false,
  mergingSince: null,
  mergingTrainId: null,
  mergeTrainPrs: null,
  autopilotEnabled: null,
  autopilotStepCount: 0,
  autopilotPaused: false,
  autopilotComplete: false,
  autopilotQuestion: null,
  planGateEnabled: null,
  planPhase: null,
  autoMergeEnabled: null,
  autoMergeRebaseCount: 0,
  auto: false,
  sandboxApplied: null,
  sandboxDegraded: false,
  egressApplied: false,
  egressDegraded: false,
  research: false,
  epicAuthoring: false,
  issueNumber: null,
  lastState: "working",
  createdAt: 0,
  updatedAt: 0,
  archivedAt: null,
  haltReason: null,
  haltedAt: null,
  manualSteps: [],
  manualStepsAckedAt: null,
  experimentId: null,
  experimentRole: null,
});

test("applies snapshot, new, status, archived", () => {
  const store = new HerdStore();
  store.setAll([s("a"), s("b")]);
  expect(store.sessions.length).toBe(2);
  store.apply({ event: "session:new", data: s("c") });
  expect(store.sessions.length).toBe(3);
  store.apply({ event: "session:status", data: { id: "a", status: "blocked" } });
  expect(store.byId("a")?.status).toBe("blocked");
  store.apply({ event: "session:archived", data: { id: "b" } });
  expect(store.sessions.find((x) => x.id === "b")).toBeUndefined();
});

test("applies usage:limits", () => {
  const store = new HerdStore();
  expect(store.usageLimits).toBeNull();
  store.apply({
    event: "usage:limits",
    data: {
      session5h: { pct: 12, resetAt: 1000 },
      week: { pct: 40, resetAt: 2000 },
      perModelWeek: [],
      credits: null,
      stale: false,
      calibratedAt: 5,
      subscriptionOnly: false,
    },
  });
  expect(store.usageLimits?.session5h?.pct).toBe(12);
  expect(store.usageLimits?.week?.pct).toBe(40);
});

test("tracks session:block reasons and preserves since across re-classification", () => {
  const store = new HerdStore();
  const reason = { shape: "menu", options: [{ label: "Yes", send: "1" }], tail: ["?"] };
  store.apply({ event: "session:block", data: { id: "s1", block: reason as any } });
  const since1 = store.blocks["s1"]!.since;
  expect(store.blocks["s1"]!.reason).toEqual(reason);
  store.apply({
    event: "session:block",
    data: { id: "s1", block: { ...reason, tail: ["??"] } as any },
  });
  expect(store.blocks["s1"]!.since).toBe(since1); // preserved
  store.apply({ event: "session:block", data: { id: "s1", block: null } });
  expect(store.blocks["s1"]).toBeUndefined();
});

test("clears block state when the session is archived", () => {
  const store = new HerdStore();
  store.apply({
    event: "session:block",
    data: { id: "s1", block: { shape: "yes-no", options: [], tail: [] } as any },
  });
  store.apply({ event: "session:archived", data: { id: "s1" } });
  expect(store.blocks["s1"]).toBeUndefined();
});

const upd = (behind: number, current: string, latest = current) => ({
  behind,
  current,
  latest,
  commits: behind ? [{ sha: latest, subject: "feat: x" }] : [],
  checkedAt: 0,
});

test("applies update:status", () => {
  const store = new HerdStore();
  expect(store.update).toBeNull();
  store.apply({ event: "update:status", data: upd(2, "aaa", "bbb") });
  expect(store.update?.behind).toBe(2);
  expect(store.update?.latest).toBe("bbb");
});

test("update without a confirmed apply just stores (no reload)", () => {
  const store = new HerdStore();
  store.apply({ event: "update:status", data: upd(0, "aaa") }); // pins running version
  store.apply({ event: "update:status", data: upd(1, "aaa", "bbb") });
  // a different `current` arrives but we never confirmed → still just stored, no throw
  store.apply({ event: "update:status", data: upd(0, "bbb") });
  expect(store.update?.current).toBe("bbb");
  expect(store.updating).toBe(false);
});

test("beginUpdate marks the store as updating", () => {
  const store = new HerdStore();
  store.beginUpdate();
  expect(store.updating).toBe(true);
});
