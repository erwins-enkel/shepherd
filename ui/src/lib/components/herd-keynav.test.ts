import { test, expect } from "vitest";
import { railOrder, cycleId, nthId, nextNeedsYou, altComboKey } from "./herd-keynav";
import type { Session, GitState, SessionStatus } from "$lib/types";

function session(id: string, readyToMerge = false, status: SessionStatus = "running"): Session {
  return {
    id,
    desig: "TASK-01",
    name: "n",
    prompt: "p",
    repoPath: "/r",
    baseBranch: "main",
    branch: "b",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "a",
    claudeSessionId: "c",
    model: null,
    status,
    readyToMerge,
    mergingSince: null,
    mergingTrainId: null,
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
    issueNumber: null,
    lastState: "working",
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
  };
}

function git(state: GitState["state"], checks: GitState["checks"] = "none"): GitState {
  return { kind: "github", state, checks, deployConfigured: false };
}

test("railOrder flattens the partition in the rail's render order", () => {
  // input order interleaves stages; the rail renders active → ciRunning →
  // ready → merging → merged (among others), preserving input order within each
  // group — ready precedes merging precedes merged in the flattened output.
  const merging1 = { ...session("merging1"), mergingSince: Date.now(), mergingTrainId: "t" };
  const list = [
    session("merged1"),
    session("ready1", true),
    session("a"),
    merging1,
    session("ci1"),
    session("b"),
  ];
  const order = railOrder(list, { merged1: git("merged"), ci1: git("open", "pending") });
  expect(order).toEqual(["a", "b", "ci1", "ready1", "merging1", "merged1"]);
});

test("railOrder under the ready filter only walks rows the rail shows", () => {
  // "ready" hides running and in-review sessions — keynav must match, so j/k
  // and 1-9 can never select a session the filtered rail isn't rendering
  const list = [
    session("running1"),
    session("idle1", false, "idle"),
    session("blocked1", false, "blocked"),
    session("reviewed1", false, "done"),
  ];
  const inReview = (id: string) => id === "reviewed1";
  expect(railOrder(list, {}, inReview, 0, "ready")).toEqual(["idle1", "blocked1"]);
  // default "all" keeps everything
  expect(railOrder(list, {}, inReview, 0)).toEqual(["running1", "idle1", "blocked1", "reviewed1"]);
});

test("railOrder of an empty herd is empty", () => {
  expect(railOrder([], {})).toEqual([]);
});

test("cycleId steps down and up through the order", () => {
  const order = ["a", "b", "c"];
  expect(cycleId(order, "a", 1)).toBe("b");
  expect(cycleId(order, "b", -1)).toBe("a");
});

test("cycleId wraps at both ends", () => {
  const order = ["a", "b", "c"];
  expect(cycleId(order, "c", 1)).toBe("a");
  expect(cycleId(order, "a", -1)).toBe("c");
});

test("cycleId with no/unknown selection lands on first (down) or last (up)", () => {
  const order = ["a", "b", "c"];
  expect(cycleId(order, null, 1)).toBe("a");
  expect(cycleId(order, null, -1)).toBe("c");
  expect(cycleId(order, "gone", 1)).toBe("a");
  expect(cycleId(order, "gone", -1)).toBe("c");
});

test("cycleId on an empty order is null; single entry cycles onto itself", () => {
  expect(cycleId([], "a", 1)).toBeNull();
  expect(cycleId(["only"], "only", 1)).toBe("only");
});

test("nthId picks the 1-based Nth visible session, null out of range", () => {
  const order = ["a", "b", "c"];
  expect(nthId(order, 1)).toBe("a");
  expect(nthId(order, 3)).toBe("c");
  expect(nthId(order, 4)).toBeNull();
  expect(nthId(order, 0)).toBeNull();
  expect(nthId([], 1)).toBeNull();
});

test("nextNeedsYou jumps to the first blocked session when current isn't blocked", () => {
  expect(nextNeedsYou(["x", "y"], "other")).toBe("x");
  expect(nextNeedsYou(["x", "y"], null)).toBe("x");
});

test("nextNeedsYou cycles among blocked sessions, wrapping", () => {
  expect(nextNeedsYou(["x", "y", "z"], "x")).toBe("y");
  expect(nextNeedsYou(["x", "y", "z"], "z")).toBe("x");
});

test("nextNeedsYou is a no-op (null) when none are blocked or only the current one is", () => {
  expect(nextNeedsYou([], "a")).toBeNull();
  expect(nextNeedsYou(["a"], "a")).toBeNull();
});

// altComboKey — physical KeyboardEvent.code → keynav key vocabulary

test("altComboKey maps j/k/g letter codes", () => {
  expect(altComboKey("KeyJ")).toBe("j");
  expect(altComboKey("KeyK")).toBe("k");
  expect(altComboKey("KeyG")).toBe("g");
});

test("altComboKey maps arrow codes", () => {
  expect(altComboKey("ArrowDown")).toBe("arrowdown");
  expect(altComboKey("ArrowUp")).toBe("arrowup");
});

test("altComboKey maps Digit1–Digit9 to '1'–'9'", () => {
  for (let n = 1; n <= 9; n++) {
    expect(altComboKey(`Digit${n}`)).toBe(String(n));
  }
});

test("altComboKey returns null for non-combo codes", () => {
  expect(altComboKey("KeyN")).toBeNull();
  expect(altComboKey("Digit0")).toBeNull();
  expect(altComboKey("Numpad1")).toBeNull();
  expect(altComboKey("Escape")).toBeNull();
  expect(altComboKey("")).toBeNull();
});
