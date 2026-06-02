import { test, expect } from "vitest";
import { partitionSessions } from "./herd-partition";
import type { Session, GitState } from "$lib/types";

function session(id: string, readyToMerge = false): Session {
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
    status: "running",
    readyToMerge,
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

test("open PR with pending CI lands in the prRunning group", () => {
  const list = [session("a"), session("p1"), session("b")];
  const { active, prRunning } = partitionSessions(list, { p1: git("open", "pending") });
  expect(active.map((s) => s.id)).toEqual(["a", "b"]);
  expect(prRunning.map((s) => s.id)).toEqual(["p1"]);
});

test("open PR with non-pending CI stays active", () => {
  const list = [session("s"), session("n")];
  const { active, prRunning } = partitionSessions(list, {
    s: git("open", "success"),
    n: git("open", "none"),
  });
  expect(active.map((s) => s.id)).toEqual(["s", "n"]);
  expect(prRunning).toHaveLength(0);
});

test("a session under review lands in the reviewerRunning group", () => {
  const list = [session("a"), session("rv"), session("b")];
  const { active, reviewerRunning } = partitionSessions(list, {}, (id) => id === "rv");
  expect(active.map((s) => s.id)).toEqual(["a", "b"]);
  expect(reviewerRunning.map((s) => s.id)).toEqual(["rv"]);
});

test("reviewing wins over pending CI when both apply", () => {
  const list = [session("x")];
  const { prRunning, reviewerRunning } = partitionSessions(
    list,
    { x: git("open", "pending") },
    () => true,
  );
  expect(prRunning).toHaveLength(0);
  expect(reviewerRunning.map((s) => s.id)).toEqual(["x"]);
});

test("merged and ready win over reviewing and pending CI", () => {
  const list = [session("m"), session("r", true)];
  const { ready, merged, prRunning, reviewerRunning } = partitionSessions(
    list,
    { m: git("merged", "pending"), r: git("open", "pending") },
    () => true,
  );
  expect(merged.map((s) => s.id)).toEqual(["m"]);
  expect(ready.map((s) => s.id)).toEqual(["r"]);
  expect(prRunning).toHaveLength(0);
  expect(reviewerRunning).toHaveLength(0);
});

test("preserves input order within the new stage groups", () => {
  const list = [session("p1"), session("v1"), session("p2"), session("v2")];
  const { prRunning, reviewerRunning } = partitionSessions(
    list,
    { p1: git("open", "pending"), p2: git("open", "pending") },
    (id) => id.startsWith("v"),
  );
  expect(prRunning.map((s) => s.id)).toEqual(["p1", "p2"]);
  expect(reviewerRunning.map((s) => s.id)).toEqual(["v1", "v2"]);
});

test("omitted reviewing predicate leaves reviewerRunning empty", () => {
  const { reviewerRunning } = partitionSessions([session("a")], {});
  expect(reviewerRunning).toHaveLength(0);
});
