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

function git(state: GitState["state"]): GitState {
  return { kind: "github", state, checks: "none", deployConfigured: false };
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
