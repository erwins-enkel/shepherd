import { test, expect } from "vitest";
import { partitionSessions } from "./herd-partition";
import type { Session } from "$lib/types";

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

test("ready sessions land in the ready group, active stay on top", () => {
  const list = [session("a"), session("r1", true), session("b"), session("r2", true), session("c")];
  const { active, ready } = partitionSessions(list);
  expect(active.map((s) => s.id)).toEqual(["a", "b", "c"]);
  expect(ready.map((s) => s.id)).toEqual(["r1", "r2"]);
});

test("preserves input order within each group", () => {
  const list = [session("r1", true), session("a"), session("r2", true), session("b")];
  const { active, ready } = partitionSessions(list);
  expect(active.map((s) => s.id)).toEqual(["a", "b"]);
  expect(ready.map((s) => s.id)).toEqual(["r1", "r2"]);
});

test("all-active yields an empty ready group", () => {
  const { active, ready } = partitionSessions([session("a"), session("b")]);
  expect(active).toHaveLength(2);
  expect(ready).toHaveLength(0);
});
