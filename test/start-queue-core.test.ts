import { describe, expect, test } from "bun:test";
import {
  START_PACE_MS,
  START_STALE_MS,
  StartQueue,
  type StartEntry,
} from "../src/start-queue-core";

// The host-wide start queue: under memory pressure new sessions wait, then start FIFO, one at a
// time, a pace apart.

function task(id: string): StartEntry {
  return { key: `task:${id}`, kind: "task", repoPath: "/r", issueNumber: null, label: id };
}

function drain(repo: string): StartEntry {
  return { key: `drain:${repo}`, kind: "drain", repoPath: repo, issueNumber: 7, label: "Fix" };
}

const OFF = (now: number) => ({ now, brakeEngaged: false });
const ON = (now: number) => ({ now, brakeEngaged: true });

describe("StartQueue", () => {
  test("an idle host lets every start through without pacing", () => {
    const q = new StartQueue();
    expect(q.admit(task("a"), OFF(0))).toBe(true);
    expect(q.admit(task("b"), OFF(1))).toBe(true);
    expect(q.list()).toEqual([]);
  });

  test("the brake queues starts in arrival order and keeps a waiter's place on a repeat ask", () => {
    const q = new StartQueue();
    expect(q.admit(task("a"), ON(10))).toBe(false);
    expect(q.admit(drain("/x"), ON(20))).toBe(false);
    expect(q.admit(task("a"), ON(30))).toBe(false);
    expect(q.list().map((w) => [w.key, w.since, w.seenAt])).toEqual([
      ["task:a", 10, 30],
      ["drain:/x", 20, 20],
    ]);
  });

  test("once the brake lets go only the head starts, then the next waits a pace", () => {
    const q = new StartQueue();
    q.admit(task("a"), ON(0));
    q.admit(drain("/x"), ON(1));
    expect(q.admit(drain("/x"), OFF(100))).toBe(false); // not its turn
    expect(q.admit(task("a"), OFF(100))).toBe(true);
    expect(q.admit(drain("/x"), OFF(100 + START_PACE_MS - 1))).toBe(false);
    expect(q.admit(drain("/x"), OFF(100 + START_PACE_MS))).toBe(true);
    expect(q.list()).toEqual([]);
  });

  test("a newcomer queues behind waiters, even with the brake off", () => {
    const q = new StartQueue();
    q.admit(task("a"), ON(0));
    expect(q.admit(task("b"), OFF(5))).toBe(false);
    expect(q.list().map((w) => w.key)).toEqual(["task:a", "task:b"]);
  });

  test("the last waiter starting still paces whatever comes next", () => {
    const q = new StartQueue();
    q.admit(task("a"), ON(0));
    expect(q.admit(task("a"), OFF(10))).toBe(true);
    expect(q.admit(task("b"), OFF(11))).toBe(false);
  });

  test("`queued` paces after a start this queue never saw wait", () => {
    const q = new StartQueue();
    expect(q.admit(task("a"), OFF(0), true)).toBe(true);
    expect(q.admit(task("b"), OFF(1))).toBe(false);
    expect(q.admit(task("b"), OFF(START_PACE_MS))).toBe(true);
  });

  test("forget and clear drop waiters; prune drops ones nobody asked about", () => {
    const q = new StartQueue();
    q.admit(task("a"), ON(0));
    q.admit(task("b"), ON(0));
    q.admit(task("c"), ON(START_STALE_MS));
    expect(q.forget("task:b")).toBe(true);
    expect(q.waiting("task:b")).toBe(false);
    expect(q.prune(START_STALE_MS + 1)).toBe(true);
    expect(q.list().map((w) => w.key)).toEqual(["task:c"]);
    expect(q.prune(START_STALE_MS + 1)).toBe(false);
    q.clear();
    expect(q.list()).toEqual([]);
  });

  test("a stale head no longer blocks once pruned", () => {
    const q = new StartQueue();
    q.admit(task("gone"), ON(0));
    q.prune(START_STALE_MS + 1);
    expect(q.admit(task("b"), OFF(START_STALE_MS + 1))).toBe(true);
  });
});
