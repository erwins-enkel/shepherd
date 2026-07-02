import { test, expect } from "vitest";
import { deriveTabState } from "./tab-signal.svelte";
import type { Session, GitState, SessionStatus, ChecksState } from "./types";

const sess = (id: string, status: SessionStatus, readyToMerge = false): Session =>
  ({ id, status, readyToMerge }) as unknown as Session;

const git = (checks: ChecksState, handoff?: "reviewer" | "merger"): GitState =>
  ({ checks, handoff }) as unknown as GitState;

test("no sessions → count 0, severity none", () => {
  expect(deriveTabState([], {}, {})).toEqual({ count: 0, severity: "none" });
});

test("blocked session counts as amber", () => {
  expect(deriveTabState([sess("s1", "blocked")], {}, {})).toEqual({ count: 1, severity: "amber" });
});

test("working-blocked session (mid-turn) is excluded — renders as running", () => {
  expect(deriveTabState([sess("s1", "blocked")], {}, { s1: true })).toEqual({
    count: 0,
    severity: "none",
  });
});

test("ci-red (git.checks === failure) counts as red", () => {
  expect(deriveTabState([sess("s1", "running")], { s1: git("failure") }, {})).toEqual({
    count: 1,
    severity: "red",
  });
});

test("blocked + CI-red on one session reads red, not amber (no primary-hold masking)", () => {
  // The whole point of reading git.checks directly rather than the primary-only
  // store.holds: a blocked session that is ALSO CI-red must surface red.
  expect(deriveTabState([sess("s1", "blocked")], { s1: git("failure") }, {})).toEqual({
    count: 1,
    severity: "red",
  });
});

test("ready-to-merge counts as green", () => {
  expect(deriveTabState([sess("s1", "done", true)], {}, {})).toEqual({
    count: 1,
    severity: "green",
  });
});

test("ready-to-merge handed to a merger is excluded (awaiting-merge, not ready)", () => {
  expect(deriveTabState([sess("s1", "done", true)], { s1: git("success", "merger") }, {})).toEqual({
    count: 0,
    severity: "none",
  });
});

test("ready-to-merge handed to a reviewer still counts as green", () => {
  expect(
    deriveTabState([sess("s1", "done", true)], { s1: git("success", "reviewer") }, {}),
  ).toEqual({ count: 1, severity: "green" });
});

test("critic-rework / plain running sessions are not counted", () => {
  // deriveTabState never inspects review verdicts, so an agent-turn session
  // (e.g. critic-rework) with no blocked/ci-red/ready signal produces nothing.
  expect(deriveTabState([sess("s1", "running")], {}, {})).toEqual({ count: 0, severity: "none" });
});

test("severity precedence across sessions: red > amber > green; count is distinct sessions", () => {
  const sessions = [sess("green", "done", true), sess("amber", "blocked"), sess("red", "running")];
  const g = { red: git("failure") };
  expect(deriveTabState(sessions, g, {})).toEqual({ count: 3, severity: "red" });
});

test("non-failure CI does not count", () => {
  const sessions = [sess("s1", "running"), sess("s2", "idle")];
  const g = { s1: git("success"), s2: git("pending") };
  expect(deriveTabState(sessions, g, {})).toEqual({ count: 0, severity: "none" });
});
