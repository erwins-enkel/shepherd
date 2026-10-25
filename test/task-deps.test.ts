import { test, expect } from "bun:test";
import { afterGateOpen, predecessorLanded, type TaskDepsStore } from "../src/task-deps";
import type { Session } from "../src/types";

const session = (over: Partial<Session> = {}) =>
  ({
    id: "a",
    repoPath: "/r",
    status: "idle",
    archiveReason: null,
    issueNumber: null,
    ...over,
  }) as Session;

function store(rows: Session[], integrated: number[] = []): TaskDepsStore {
  return {
    get: (id) => rows.find((r) => r.id === id) ?? null,
    isEpicIntegratedChild: (_repo, n) => integrated.includes(n),
  };
}

const none = () => undefined;

test("live merged PR counts as landed", () => {
  const s = session();
  expect(predecessorLanded(store([s]), () => ({ state: "merged" }), s)).toBe(true);
});

test("open PR / running session is not landed", () => {
  const s = session({ status: "running" });
  expect(predecessorLanded(store([s]), () => ({ state: "open" }), s)).toBe(false);
});

test("archived as merged counts as landed", () => {
  const s = session({ status: "archived", archiveReason: "merged" });
  expect(predecessorLanded(store([s]), none, s)).toBe(true);
});

test("epic child integrated by the drain counts as landed", () => {
  const s = session({ status: "archived", archiveReason: "drain", issueNumber: 7 });
  expect(predecessorLanded(store([s], [7]), none, s)).toBe(true);
  expect(predecessorLanded(store([s]), none, s)).toBe(false);
});

test("operator archive without a merge is not landed", () => {
  const s = session({ status: "archived", archiveReason: "operator" });
  expect(predecessorLanded(store([s]), () => ({ state: "closed" }), s)).toBe(false);
});

test("afterGateOpen: no predecessor, pruned predecessor → open", () => {
  expect(afterGateOpen(store([]), none, undefined)).toBe(true);
  expect(afterGateOpen(store([]), none, "gone")).toBe(true);
});

test("afterGateOpen follows predecessorLanded", () => {
  const s = session({ status: "running" });
  expect(afterGateOpen(store([s]), none, "a")).toBe(false);
  expect(afterGateOpen(store([s]), () => ({ state: "merged" }), "a")).toBe(true);
});
