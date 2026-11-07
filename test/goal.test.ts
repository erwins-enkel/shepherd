import { describe, expect, test } from "bun:test";
import {
  GOAL_CONDITION_MAX,
  GoalTracker,
  goalArmCommand,
  latestGoalStatus,
  normalizeGoalCondition,
  splitHeldGoal,
} from "../src/goal";
import type { GoalState, Session } from "../src/types";

// Shapes as written by Claude Code 2.1.319 (live-tested, #2596).
const set = (c: string) =>
  JSON.stringify({
    type: "attachment",
    attachment: { type: "goal_status", met: false, sentinel: true, condition: c },
  });
const evaluated = (c: string, met: boolean) =>
  JSON.stringify({
    type: "attachment",
    attachment: { type: "goal_status", met, condition: c, reason: "r", iterations: 1 },
  });
const noise = JSON.stringify({ type: "user", message: { role: "user", content: "goal_status" } });

describe("splitHeldGoal", () => {
  test("splits a leading /goal into condition + task", () => {
    expect(splitHeldGoal("/goal make it responsive")).toEqual({
      condition: "make it responsive",
      task: "make it responsive",
    });
  });
  test("tolerates leading whitespace and multi-line conditions (condition one line)", () => {
    expect(splitHeldGoal("  /goal line one\n\nline two  ")).toEqual({
      condition: "line one line two",
      task: "line one\n\nline two",
    });
  });
  test("not a goal / empty / clear / too long → null", () => {
    expect(splitHeldGoal("make it responsive")).toBeNull();
    expect(splitHeldGoal("/goals x")).toBeNull();
    expect(splitHeldGoal("/goal")).toBeNull();
    expect(splitHeldGoal("/goal   ")).toBeNull();
    expect(splitHeldGoal("/goal clear")).toBeNull();
    expect(splitHeldGoal("/goal CLEAR")).toBeNull();
    expect(splitHeldGoal(`/goal ${"x".repeat(GOAL_CONDITION_MAX + 1)}`)).toBeNull();
    expect(splitHeldGoal(`/goal ${"x".repeat(GOAL_CONDITION_MAX)}`)?.condition).toHaveLength(
      GOAL_CONDITION_MAX,
    );
  });
});

test("normalizeGoalCondition strips control chars and collapses whitespace", () => {
  expect(normalizeGoalCondition("a\r\nb\t\u001b[31mc  ")).toBe("a b [31mc");
});

test("goalArmCommand", () => {
  expect(goalArmCommand("X")).toBe("/goal X");
});

describe("latestGoalStatus", () => {
  test("newest entry wins; malformed and unrelated lines skipped", () => {
    const tail = [set("A"), evaluated("A", false), "{bad goal_status", noise].join("\n");
    expect(latestGoalStatus(tail)).toEqual({ condition: "A", met: false });
    expect(latestGoalStatus([set("A"), evaluated("A", true)].join("\n"))).toEqual({
      condition: "A",
      met: true,
    });
  });
  test("none → null", () => {
    expect(latestGoalStatus(noise)).toBeNull();
    expect(latestGoalStatus("")).toBeNull();
  });
});

describe("GoalTracker.onStop", () => {
  function setup(tail: string | Error, session: Partial<Session> = {}) {
    const writes: Array<[string, string | null, GoalState | null]> = [];
    const emitted: unknown[] = [];
    const tracker = new GoalTracker({
      store: { setGoal: (id, c, st) => writes.push([id, c, st]) },
      events: { emit: (ev, data) => emitted.push([ev, data]) },
      transcriptPath: () => "/t.jsonl",
      readTail: async () => {
        if (tail instanceof Error) throw tail;
        return tail;
      },
    });
    const s = {
      id: "s1",
      agentProvider: "claude",
      planPhase: "planning",
      goalCondition: null,
      goalState: null,
      ...session,
    } as Session;
    return { tracker, s, writes, emitted };
  }

  test("planning + active goal → pause, row becomes active", async () => {
    const { tracker, s, writes, emitted } = setup(set("A"));
    expect(await tracker.onStop(s)).toEqual({ pause: true });
    expect(writes).toEqual([["s1", "A", "active"]]);
    expect(emitted).toEqual([
      ["session:goal", { id: "s1", goalCondition: "A", goalState: "active" }],
    ]);
  });

  test("executing + active goal → no pause", async () => {
    const { tracker, s } = setup(set("A"), { planPhase: "executing" });
    expect(await tracker.onStop(s)).toEqual({ pause: false });
  });

  test("met goal clears an active row; unchanged row writes nothing", async () => {
    const met = setup(evaluated("A", true), { goalCondition: "A", goalState: "active" });
    expect(await met.tracker.onStop(met.s)).toEqual({ pause: false });
    expect(met.writes).toEqual([["s1", null, null]]);
    const same = setup(set("A"), { goalCondition: "A", goalState: "active" });
    await same.tracker.onStop(same.s);
    expect(same.writes).toEqual([]);
    expect(same.emitted).toEqual([]);
  });

  test("held goal is never overwritten by the transcript", async () => {
    const { tracker, s, writes } = setup("", { goalCondition: "H", goalState: "held" });
    expect(await tracker.onStop(s)).toEqual({ pause: false });
    expect(writes).toEqual([]);
  });

  test("unreadable transcript / codex / no path → no pause, no write", async () => {
    const err = setup(new Error("ENOENT"));
    expect(await err.tracker.onStop(err.s)).toEqual({ pause: false });
    expect(err.writes).toEqual([]);
    const codex = setup(set("A"), { agentProvider: "codex" });
    expect(await codex.tracker.onStop(codex.s)).toEqual({ pause: false });
    const noPath = new GoalTracker({ store: { setGoal: () => {} }, transcriptPath: () => null });
    expect(await noPath.onStop(err.s)).toEqual({ pause: false });
  });

  test("slow read times out → fail open", async () => {
    const tracker = new GoalTracker({
      store: { setGoal: () => {} },
      transcriptPath: () => "/t.jsonl",
      readTail: () => new Promise(() => {}),
      timeoutMs: 10,
    });
    expect(await tracker.onStop({ id: "s", planPhase: "planning" } as Session)).toEqual({
      pause: false,
    });
  });
});
