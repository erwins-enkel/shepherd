import type { AutoMergeStatus } from "../../src/automerge";
import type { DrainStatus, QueuedItem } from "../../src/drain";
import type { PostMergeStep, BuildStepInput } from "../../src/types";
export const auto: AutoMergeStatus = {
  repoPath: "/fixture",
  enabled: true,
  state: "manual_steps",
  detail: "TASK-1",
  sessionId: "a",
};
export const drain: DrainStatus = {
  repoPath: "/fixture",
  enabled: true,
  paused: true,
  reason: "usage",
  detail: "80",
  queued: 1,
  inFlight: 1,
  max: 2,
  epicParent: 200,
  runSummary: {
    leadingEpic: 200,
    windingDown: [{ epic: 100, inFlight: [101] }],
    slots: {
      used: 1,
      max: 2,
      holders: [{ sessionId: "a", desig: "TASK-1", issueNumber: 101, epicParent: 100 }],
    },
    next: [201],
    after: [202],
  },
};
export const queued: QueuedItem[] = [{ number: 7, title: "Ship", url: "https://example.test/i/7" }];
export const steps: PostMergeStep[] = [
  { id: "one", text: "Rotate fixture key", postMerge: true, doneAt: null },
];
export const build: BuildStepInput[] = [
  { id: "one", title: "Build", detail: "Run checks", status: "pending" },
];
