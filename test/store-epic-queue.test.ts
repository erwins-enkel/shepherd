import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";

const base = { mode: "auto" as const, agentProvider: null, model: null, effort: null };
const parents = (s: SessionStore, repo: string) =>
  s.listEpicQueue(repo).map((e) => e.parentIssueNumber);

test("enqueueEpic appends to the tail, per repo", () => {
  const s = new SessionStore(":memory:");
  s.enqueueEpic({ ...base, repoPath: "/a", parentIssueNumber: 30 });
  s.enqueueEpic({ ...base, repoPath: "/a", parentIssueNumber: 10 });
  s.enqueueEpic({ ...base, repoPath: "/b", parentIssueNumber: 5 });
  expect(parents(s, "/a")).toEqual([30, 10]);
  expect(parents(s, "/b")).toEqual([5]);
});

test("enqueueEpic with head puts the epic in front; reorder and shift still follow it", () => {
  const s = new SessionStore(":memory:");
  s.enqueueEpic({ ...base, repoPath: "/a", parentIssueNumber: 9 }, { head: true });
  expect(parents(s, "/a")).toEqual([9]);
  s.enqueueEpic({ ...base, repoPath: "/a", parentIssueNumber: 30 });
  s.enqueueEpic({ ...base, repoPath: "/a", parentIssueNumber: 10 }, { head: true });
  s.enqueueEpic({ ...base, repoPath: "/a", parentIssueNumber: 11 }, { head: true });
  expect(parents(s, "/a")).toEqual([11, 10, 9, 30]);
  // Already queued: keeps its place.
  s.enqueueEpic({ ...base, repoPath: "/a", parentIssueNumber: 30 }, { head: true });
  expect(parents(s, "/a")).toEqual([11, 10, 9, 30]);
  expect(s.reorderEpicQueue("/a", [30, 9, 10, 11])).toBe(true);
  expect(parents(s, "/a")).toEqual([30, 9, 10, 11]);
  s.enqueueEpic({ ...base, repoPath: "/a", parentIssueNumber: 12 }, { head: true });
  expect(s.shiftEpicQueue("/a")!.parentIssueNumber).toBe(12);
  expect(parents(s, "/a")).toEqual([30, 9, 10, 11]);
});

test("re-enqueueing a queued epic keeps its position and settings", () => {
  const s = new SessionStore(":memory:");
  s.enqueueEpic({ ...base, repoPath: "/a", parentIssueNumber: 1, mode: "attended" });
  s.enqueueEpic({ ...base, repoPath: "/a", parentIssueNumber: 2 });
  s.enqueueEpic({ ...base, repoPath: "/a", parentIssueNumber: 1 });
  expect(parents(s, "/a")).toEqual([1, 2]);
  expect(s.getEpicQueueEntry("/a", 1)!.mode).toBe("attended");
});

test("shiftEpicQueue returns the head with its settings and removes it", () => {
  const s = new SessionStore(":memory:");
  s.enqueueEpic({
    repoPath: "/a",
    parentIssueNumber: 7,
    mode: "attended",
    agentProvider: "codex",
    model: "gpt-5.5",
    effort: "high",
  });
  s.enqueueEpic({ ...base, repoPath: "/a", parentIssueNumber: 8 });
  expect(s.shiftEpicQueue("/a")).toMatchObject({
    repoPath: "/a",
    parentIssueNumber: 7,
    mode: "attended",
    agentProvider: "codex",
    model: "gpt-5.5",
    effort: "high",
  });
  expect(parents(s, "/a")).toEqual([8]);
  expect(s.shiftEpicQueue("/a")!.parentIssueNumber).toBe(8);
  expect(s.shiftEpicQueue("/a")).toBeNull();
});

test("a model/effort without a provider is not stored", () => {
  const s = new SessionStore(":memory:");
  s.enqueueEpic({ ...base, repoPath: "/a", parentIssueNumber: 1, model: "opus", effort: "high" });
  expect(s.getEpicQueueEntry("/a", 1)).toMatchObject({ model: null, effort: null });
});

test("updateEpicQueueSettings replaces settings, keeps position", () => {
  const s = new SessionStore(":memory:");
  s.enqueueEpic({ ...base, repoPath: "/a", parentIssueNumber: 1 });
  s.enqueueEpic({ ...base, repoPath: "/a", parentIssueNumber: 2 });
  s.updateEpicQueueSettings({
    repoPath: "/a",
    parentIssueNumber: 1,
    mode: "attended",
    agentProvider: "claude",
    model: "opus",
    effort: "max",
  });
  expect(parents(s, "/a")).toEqual([1, 2]);
  expect(s.getEpicQueueEntry("/a", 1)).toMatchObject({
    mode: "attended",
    agentProvider: "claude",
    model: "opus",
    effort: "max",
  });
});

test("removeEpicQueueEntry drops one entry and reports whether it was queued", () => {
  const s = new SessionStore(":memory:");
  s.enqueueEpic({ ...base, repoPath: "/a", parentIssueNumber: 1 });
  s.enqueueEpic({ ...base, repoPath: "/a", parentIssueNumber: 2 });
  expect(s.removeEpicQueueEntry("/a", 1)).toBe(true);
  expect(s.removeEpicQueueEntry("/a", 1)).toBe(false);
  expect(parents(s, "/a")).toEqual([2]);
  expect(s.getEpicQueueEntry("/a", 1)).toBeNull();
  // A later enqueue still lands behind the survivors.
  s.enqueueEpic({ ...base, repoPath: "/a", parentIssueNumber: 1 });
  expect(parents(s, "/a")).toEqual([2, 1]);
});

test("reorderEpicQueue puts the queue in the given order; the head shifts first (#2973)", () => {
  const s = new SessionStore(":memory:");
  for (const n of [1, 2, 3]) s.enqueueEpic({ ...base, repoPath: "/a", parentIssueNumber: n });
  s.enqueueEpic({ ...base, repoPath: "/b", parentIssueNumber: 9 });
  expect(s.reorderEpicQueue("/a", [3, 1, 2])).toBe(true);
  expect(parents(s, "/a")).toEqual([3, 1, 2]);
  expect(parents(s, "/b")).toEqual([9]);
  expect(s.shiftEpicQueue("/a")!.parentIssueNumber).toBe(3);
  s.enqueueEpic({ ...base, repoPath: "/a", parentIssueNumber: 4 });
  expect(parents(s, "/a")).toEqual([1, 2, 4]);
});

test("reorderEpicQueue refuses an order that is not the queue's permutation", () => {
  const s = new SessionStore(":memory:");
  for (const n of [1, 2]) s.enqueueEpic({ ...base, repoPath: "/a", parentIssueNumber: n });
  expect(s.reorderEpicQueue("/a", [2])).toBe(false);
  expect(s.reorderEpicQueue("/a", [2, 1, 3])).toBe(false);
  expect(s.reorderEpicQueue("/a", [2, 2])).toBe(false);
  expect(s.reorderEpicQueue("/a", [2, 3])).toBe(false);
  expect(parents(s, "/a")).toEqual([1, 2]);
});
