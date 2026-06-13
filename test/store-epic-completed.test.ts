import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";

test("recordEpicCompleted + listEpicCompleted basic round-trip", () => {
  const s = new SessionStore(":memory:");
  expect(s.listEpicCompleted()).toEqual([]);

  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 10,
    parentTitle: "Epic Alpha",
    completedAt: 1000,
    childrenJson: "[]",
  });

  const list = s.listEpicCompleted();
  expect(list).toHaveLength(1);
  expect(list[0]!.repoPath).toBe("/r");
  expect(list[0]!.parentIssueNumber).toBe(10);
  expect(list[0]!.parentTitle).toBe("Epic Alpha");
  expect(list[0]!.completedAt).toBe(1000);
  expect(list[0]!.childrenJson).toBe("[]");
});

test("listEpicCompleted filters by repoPath", () => {
  const s = new SessionStore(":memory:");
  s.recordEpicCompleted({
    repoPath: "/a",
    parentIssueNumber: 1,
    parentTitle: "A",
    completedAt: 1,
    childrenJson: "[]",
  });
  s.recordEpicCompleted({
    repoPath: "/b",
    parentIssueNumber: 2,
    parentTitle: "B",
    completedAt: 2,
    childrenJson: "[]",
  });

  expect(s.listEpicCompleted("/a")).toHaveLength(1);
  expect(s.listEpicCompleted("/a")[0]!.repoPath).toBe("/a");
  expect(s.listEpicCompleted("/b")).toHaveLength(1);
  expect(s.listEpicCompleted()).toHaveLength(2);
});

test("listEpicCompleted orders by completedAt DESC", () => {
  const s = new SessionStore(":memory:");
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 1,
    parentTitle: "Old",
    completedAt: 100,
    childrenJson: "[]",
  });
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 2,
    parentTitle: "New",
    completedAt: 200,
    childrenJson: "[]",
  });

  const list = s.listEpicCompleted("/r");
  expect(list[0]!.completedAt).toBe(200);
  expect(list[1]!.completedAt).toBe(100);
});

test("dismissEpicCompleted removes it from listEpicCompleted", () => {
  const s = new SessionStore(":memory:");
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 10,
    parentTitle: "E",
    completedAt: 1,
    childrenJson: "[]",
  });
  expect(s.listEpicCompleted()).toHaveLength(1);

  s.dismissEpicCompleted("/r", 10);
  expect(s.listEpicCompleted()).toHaveLength(0);
});

test("re-recordEpicCompleted after dismiss does NOT resurrect (stays dismissed)", () => {
  const s = new SessionStore(":memory:");
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 10,
    parentTitle: "E",
    completedAt: 1,
    childrenJson: "[]",
  });
  s.dismissEpicCompleted("/r", 10);
  expect(s.listEpicCompleted()).toHaveLength(0);

  // re-record should not resurrect
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 10,
    parentTitle: "E updated",
    completedAt: 999,
    childrenJson: "[1]",
  });
  expect(s.listEpicCompleted()).toHaveLength(0);
});

test("recordEpicCompleted upsert refreshes parentTitle/completedAt/childrenJson", () => {
  const s = new SessionStore(":memory:");
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 10,
    parentTitle: "Old",
    completedAt: 1,
    childrenJson: "[]",
  });
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 10,
    parentTitle: "New",
    completedAt: 999,
    childrenJson: "[1,2]",
  });

  const list = s.listEpicCompleted();
  expect(list[0]!.parentTitle).toBe("New");
  expect(list[0]!.completedAt).toBe(999);
  expect(list[0]!.childrenJson).toBe("[1,2]");
});

test("dismissedAt IS NULL filter — dismissed epics never appear in list", () => {
  const s = new SessionStore(":memory:");
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 1,
    parentTitle: "A",
    completedAt: 1,
    childrenJson: "[]",
  });
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 2,
    parentTitle: "B",
    completedAt: 2,
    childrenJson: "[]",
  });
  s.dismissEpicCompleted("/r", 1);

  const list = s.listEpicCompleted("/r");
  expect(list).toHaveLength(1);
  expect(list[0]!.parentIssueNumber).toBe(2);
});

test("fresh recordEpicCompleted defaults landing columns (pending/null/null/0)", () => {
  const s = new SessionStore(":memory:");
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 10,
    parentTitle: "E",
    completedAt: 1,
    childrenJson: "[]",
  });

  const row = s.listEpicCompleted()[0]!;
  expect(row.landingState).toBe("pending");
  expect(row.landingPrNumber).toBe(null);
  expect(row.landingPrUrl).toBe(null);
  expect(row.landingAttempts).toBe(0);
});

test("setEpicLandingPr writes the landing resolution", () => {
  const s = new SessionStore(":memory:");
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 10,
    parentTitle: "E",
    completedAt: 1,
    childrenJson: "[]",
  });

  s.setEpicLandingPr("/r", 10, {
    state: "open",
    prNumber: 42,
    prUrl: "http://x/42",
    attempts: 0,
  });

  const row = s.listEpicCompleted()[0]!;
  expect(row.landingState).toBe("open");
  expect(row.landingPrNumber).toBe(42);
  expect(row.landingPrUrl).toBe("http://x/42");
  expect(row.landingAttempts).toBe(0);
});

test("setEpicLandingPr persists a non-zero attempts counter", () => {
  const s = new SessionStore(":memory:");
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 10,
    parentTitle: "E",
    completedAt: 1,
    childrenJson: "[]",
  });

  s.setEpicLandingPr("/r", 10, {
    state: "error",
    prNumber: null,
    prUrl: null,
    attempts: 3,
  });

  const row = s.listEpicCompleted()[0]!;
  expect(row.landingState).toBe("error");
  expect(row.landingAttempts).toBe(3);
});

test("re-recordEpicCompleted preserves landing resolution by omission", () => {
  const s = new SessionStore(":memory:");
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 10,
    parentTitle: "Old",
    completedAt: 1,
    childrenJson: "[]",
  });
  s.setEpicLandingPr("/r", 10, {
    state: "open",
    prNumber: 42,
    prUrl: "http://x/42",
    attempts: 0,
  });

  // a later re-record refreshes title/children but must NOT reset the landing back to pending
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 10,
    parentTitle: "New",
    completedAt: 999,
    childrenJson: "[1,2]",
  });

  const row = s.listEpicCompleted()[0]!;
  expect(row.parentTitle).toBe("New");
  expect(row.childrenJson).toBe("[1,2]");
  expect(row.landingState).toBe("open");
  expect(row.landingPrNumber).toBe(42);
});

test("listEpicRuns returns all persisted epic_run rows", () => {
  const s = new SessionStore(":memory:");
  expect(s.listEpicRuns()).toEqual([]);
  s.setEpicRun({ repoPath: "/a", parentIssueNumber: 1, mode: "auto", status: "idle" });
  s.setEpicRun({ repoPath: "/b", parentIssueNumber: 2, mode: "attended", status: "running" });
  const runs = s.listEpicRuns().sort((x, y) => x.repoPath.localeCompare(y.repoPath));
  expect(runs).toEqual([
    { repoPath: "/a", parentIssueNumber: 1, mode: "auto", status: "idle" },
    { repoPath: "/b", parentIssueNumber: 2, mode: "attended", status: "running" },
  ]);
});
