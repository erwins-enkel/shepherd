import { test, expect } from "vitest";
import { groupSessionsByExperiment } from "./experiment-grouping";
import type { Session, ExperimentRole } from "$lib/types";

function session(
  id: string,
  experimentId: string | null,
  experimentRole: ExperimentRole | null,
  createdAt = 0,
): Session {
  return {
    id,
    desig: "TASK-01",
    name: `name-${id}`,
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
    readyToMerge: false,
    mergingSince: null,
    mergingTrainId: null,
    mergeTrainPrs: null,
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
    egressApplied: false,
    egressDegraded: false,
    research: false,
    epicAuthoring: false,
    issueNumber: null,
    lastState: "working",
    createdAt,
    updatedAt: 0,
    archivedAt: null,
    haltReason: null,
    haltedAt: null,
    manualSteps: [],
    manualStepsAckedAt: null,
    experimentId,
    experimentRole,
  };
}

test("groups variants (+ comparison) and leaves non-experiment sessions in rest", () => {
  const a = session("a", "exp-1", "variant", 1);
  const b = session("b", "exp-1", "variant", 2);
  const cmp = session("c", "exp-1", "comparison", 3);
  const plain = session("p", null, null);
  const { groups, rest } = groupSessionsByExperiment([a, b, cmp, plain]);

  expect(groups).toHaveLength(1);
  expect(groups[0]!.experimentId).toBe("exp-1");
  expect(groups[0]!.variants.map((s) => s.id)).toEqual(["a", "b"]);
  expect(groups[0]!.comparison?.id).toBe("c");
  expect(groups[0]!.label).toBe("name-a");
  expect(rest.map((s) => s.id)).toEqual(["p"]);
});

test("a lone surviving variant falls back into rest (not a comparison set)", () => {
  const a = session("a", "exp-2", "variant", 1);
  const { groups, rest } = groupSessionsByExperiment([a]);
  expect(groups).toHaveLength(0);
  expect(rest.map((s) => s.id)).toEqual(["a"]);
});

test("keeps a group with a single variant when a comparison run exists", () => {
  const a = session("a", "exp-3", "variant", 1);
  const cmp = session("c", "exp-3", "comparison", 2);
  const { groups, rest } = groupSessionsByExperiment([a, cmp]);
  expect(groups).toHaveLength(1);
  expect(rest).toHaveLength(0);
});
