import { test, expect } from "vitest";
import { partitionSessions } from "./herd-partition";
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
    autopilotEnabled: null,
    autopilotStepCount: 0,
    autopilotPaused: false,
    autopilotQuestion: null,
    auto: false,
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

test("ready sessions land in the ready group, active stay on top", () => {
  const list = [session("a"), session("r1", true), session("b"), session("r2", true), session("c")];
  const { active, ready, merged } = partitionSessions(list, {});
  expect(active.map((s) => s.id)).toEqual(["a", "b", "c"]);
  expect(ready.map((s) => s.id)).toEqual(["r1", "r2"]);
  expect(merged).toHaveLength(0);
});

test("merged-PR sessions land in the merged group", () => {
  const list = [session("a"), session("m1"), session("b")];
  const { active, ready, merged } = partitionSessions(list, { m1: git("merged") });
  expect(active.map((s) => s.id)).toEqual(["a", "b"]);
  expect(ready).toHaveLength(0);
  expect(merged.map((s) => s.id)).toEqual(["m1"]);
});

test("merged wins over ready when both apply", () => {
  const list = [session("x", true)];
  const { ready, merged } = partitionSessions(list, { x: git("merged") });
  expect(ready).toHaveLength(0);
  expect(merged.map((s) => s.id)).toEqual(["x"]);
});

test("non-merged PR states leave the session in its base group", () => {
  const list = [session("a"), session("r1", true)];
  const { active, ready, merged } = partitionSessions(list, {
    a: git("open"),
    r1: git("open"),
  });
  expect(active.map((s) => s.id)).toEqual(["a"]);
  expect(ready.map((s) => s.id)).toEqual(["r1"]);
  expect(merged).toHaveLength(0);
});

test("preserves input order within each group", () => {
  const list = [session("r1", true), session("a"), session("r2", true), session("b")];
  const { active, ready } = partitionSessions(list, {});
  expect(active.map((s) => s.id)).toEqual(["a", "b"]);
  expect(ready.map((s) => s.id)).toEqual(["r1", "r2"]);
});

test("all-active yields empty ready and merged groups", () => {
  const { active, ready, merged } = partitionSessions([session("a"), session("b")], {});
  expect(active).toHaveLength(2);
  expect(ready).toHaveLength(0);
  expect(merged).toHaveLength(0);
});

test("open PR with pending CI lands in the ciRunning group", () => {
  const list = [session("a"), session("p1"), session("b")];
  const { active, ciRunning } = partitionSessions(list, { p1: git("open", "pending") });
  expect(active.map((s) => s.id)).toEqual(["a", "b"]);
  expect(ciRunning.map((s) => s.id)).toEqual(["p1"]);
});

test("idle session with green CI lands in awaitingMerge; no-checks PR stays active", () => {
  const list = [session("s", false, "idle"), session("n")];
  const { active, awaitingMerge, ciRunning } = partitionSessions(list, {
    s: git("open", "success"),
    n: git("open", "none"),
  });
  expect(active.map((s) => s.id)).toEqual(["n"]);
  expect(awaitingMerge.map((s) => s.id)).toEqual(["s"]);
  expect(ciRunning).toHaveLength(0);
});

test("a busy agent with green CI stays active, not awaitingMerge (auto-correct in flight)", () => {
  // After a critic steers findings back, the task agent goes `running` again while
  // the PR is still open+green (no new push yet). It is working, not handed off.
  const list = [session("c", false, "running")];
  const { active, awaitingMerge } = partitionSessions(list, { c: git("open", "success") });
  expect(awaitingMerge).toHaveLength(0);
  expect(active.map((s) => s.id)).toEqual(["c"]);
});

test("a blocked agent with green CI stays active, not awaitingMerge (needs operator input)", () => {
  // Blocked = mid-turn, awaiting operator input — still in the loop, not handed off.
  const list = [session("b", false, "blocked")];
  const { active, awaitingMerge } = partitionSessions(list, { b: git("open", "success") });
  expect(awaitingMerge).toHaveLength(0);
  expect(active.map((s) => s.id)).toEqual(["b"]);
});

test("open PR with failed CI lands in the ciFailed group", () => {
  const list = [session("a"), session("f1"), session("b")];
  const { active, ciFailed } = partitionSessions(list, { f1: git("open", "failure") });
  expect(active.map((s) => s.id)).toEqual(["a", "b"]);
  expect(ciFailed.map((s) => s.id)).toEqual(["f1"]);
});

test("reviewing wins over green CI (awaitingMerge) when both apply", () => {
  const list = [session("x")];
  const { awaitingMerge, reviewerRunning } = partitionSessions(
    list,
    { x: git("open", "success") },
    () => true,
  );
  expect(awaitingMerge).toHaveLength(0);
  expect(reviewerRunning.map((s) => s.id)).toEqual(["x"]);
});

test("operator-parked ready wins over green CI (awaitingMerge)", () => {
  const list = [session("r", true)];
  const { awaitingMerge, ready } = partitionSessions(list, { r: git("open", "success") });
  expect(awaitingMerge).toHaveLength(0);
  expect(ready.map((s) => s.id)).toEqual(["r"]);
});

test("a session under review lands in the reviewerRunning group", () => {
  const list = [session("a"), session("rv"), session("b")];
  const { active, reviewerRunning } = partitionSessions(list, {}, (id) => id === "rv");
  expect(active.map((s) => s.id)).toEqual(["a", "b"]);
  expect(reviewerRunning.map((s) => s.id)).toEqual(["rv"]);
});

test("reviewing wins over pending CI when both apply", () => {
  const list = [session("x")];
  const { ciRunning, reviewerRunning } = partitionSessions(
    list,
    { x: git("open", "pending") },
    () => true,
  );
  expect(ciRunning).toHaveLength(0);
  expect(reviewerRunning.map((s) => s.id)).toEqual(["x"]);
});

test("merged and ready win over reviewing and pending CI", () => {
  const list = [session("m"), session("r", true)];
  const { ready, merged, ciRunning, reviewerRunning } = partitionSessions(
    list,
    { m: git("merged", "pending"), r: git("open", "pending") },
    () => true,
  );
  expect(merged.map((s) => s.id)).toEqual(["m"]);
  expect(ready.map((s) => s.id)).toEqual(["r"]);
  expect(ciRunning).toHaveLength(0);
  expect(reviewerRunning).toHaveLength(0);
});

test("preserves input order within the new stage groups", () => {
  const list = [session("p1"), session("v1"), session("p2"), session("v2")];
  const { ciRunning, reviewerRunning } = partitionSessions(
    list,
    { p1: git("open", "pending"), p2: git("open", "pending") },
    (id) => id.startsWith("v"),
  );
  expect(ciRunning.map((s) => s.id)).toEqual(["p1", "p2"]);
  expect(reviewerRunning.map((s) => s.id)).toEqual(["v1", "v2"]);
});

test("omitted reviewing predicate leaves reviewerRunning empty", () => {
  const { reviewerRunning } = partitionSessions([session("a")], {});
  expect(reviewerRunning).toHaveLength(0);
});
