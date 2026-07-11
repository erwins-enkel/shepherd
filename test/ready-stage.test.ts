import { describe, test, expect } from "bun:test";
import { isReadyForNotify } from "../src/ready-stage";
import type { Session } from "../src/types";
import type { GitState } from "../src/forge/types";

const NOW = 1_700_000_000_000; // fixed epoch

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    desig: "TASK-01",
    name: "test",
    prompt: "do something",
    repoPath: "/repo",
    baseBranch: "main",
    branch: "shepherd/task-01",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "h1",
    herdrAgentId: "a1",
    claudeSessionId: "",
    model: null,
    readyToMerge: false,
    mergingSince: null,
    mergingTrainId: null,
    mergeTrainPrs: null,
    mergingPrNumber: null,
    autopilotEnabled: null,
    autopilotStepCount: 0,
    autopilotPaused: false,
    autopilotComplete: false,
    autopilotQuestion: null,
    completionRepromptCount: 0,
    planGateEnabled: null,
    planPhase: null,
    research: false,
    epicAuthoring: false,
    autoMergeEnabled: null,
    autoMergeRebaseCount: 0,
    autoMergeRebaseHead: null,
    auto: false,
    issueNumber: null,
    sandboxApplied: null,
    sandboxDegraded: false,
    egressApplied: false,
    egressDegraded: false,
    status: "idle",
    lastState: "idle",
    createdAt: NOW - 10_000,
    updatedAt: NOW - 1_000,
    archivedAt: null,
    haltReason: null,
    haltedAt: null,
    ...overrides,
  } as Session;
}

function makeGit(overrides: Partial<GitState> = {}): GitState {
  return {
    kind: "github",
    state: "open",
    checks: "none",
    deployConfigured: false,
    ...overrides,
  } as GitState;
}

const noReview: (_id: string) => boolean = () => false;
const noBlocked: Record<string, boolean> = {};

describe("isReadyForNotify", () => {
  test("plain idle session, no git → READY", () => {
    const s = makeSession({ status: "idle" });
    expect(isReadyForNotify(s, undefined, noReview, noBlocked, NOW)).toBe(true);
  });

  test("running session → NOT ready", () => {
    const s = makeSession({ status: "running" });
    expect(isReadyForNotify(s, undefined, noReview, noBlocked, NOW)).toBe(false);
  });

  test("working-while-blocked (status=blocked + workingBlocked[id]=true) → NOT ready", () => {
    const s = makeSession({ status: "blocked" });
    const wb = { s1: true };
    expect(isReadyForNotify(s, undefined, noReview, wb, NOW)).toBe(false);
  });

  test("isReviewing(id)=true → NOT ready", () => {
    const s = makeSession({ status: "idle" });
    const isReviewing = (id: string) => id === "s1";
    expect(isReadyForNotify(s, undefined, isReviewing, noBlocked, NOW)).toBe(false);
  });

  test("open PR + checks pending (ciRunning) → NOT ready", () => {
    const s = makeSession({ status: "idle" });
    const git = makeGit({ state: "open", checks: "pending" });
    expect(isReadyForNotify(s, git, noReview, noBlocked, NOW)).toBe(false);
  });

  test("open PR + checks failure (ciFailed) → READY (failed CI is your turn)", () => {
    const s = makeSession({ status: "idle" });
    const git = makeGit({ state: "open", checks: "failure" });
    expect(isReadyForNotify(s, git, noReview, noBlocked, NOW)).toBe(true);
  });

  test("open PR + checks success + idle + handoff=reviewer (waitingOnReviewer) → NOT ready", () => {
    const s = makeSession({ status: "idle" });
    const git = makeGit({ state: "open", checks: "success", handoff: "reviewer" });
    expect(isReadyForNotify(s, git, noReview, noBlocked, NOW)).toBe(false);
  });

  test("open PR + checks success + idle + handoff=merger (waitingOnMerger) → NOT ready", () => {
    const s = makeSession({ status: "idle" });
    const git = makeGit({ state: "open", checks: "success", handoff: "merger" });
    expect(isReadyForNotify(s, git, noReview, noBlocked, NOW)).toBe(false);
  });

  test("open PR + checks success + idle, no handoff (awaitingMerge) → READY", () => {
    const s = makeSession({ status: "idle" });
    const git = makeGit({ state: "open", checks: "success" });
    expect(isReadyForNotify(s, git, noReview, noBlocked, NOW)).toBe(true);
  });

  test("no-CI repo (noCi + checks:none) + idle, no handoff (awaitingMerge) → READY", () => {
    const s = makeSession({ status: "idle" });
    const git = makeGit({ state: "open", checks: "none", noCi: true });
    expect(isReadyForNotify(s, git, noReview, noBlocked, NOW)).toBe(true);
  });

  test("no-CI repo (noCi + checks:none) + idle + handoff=merger (waitingOnMerger) → NOT ready", () => {
    // Proves noCi engages greenIdle → the handoff routing (not 'active').
    const s = makeSession({ status: "idle" });
    const git = makeGit({ state: "open", checks: "none", noCi: true, handoff: "merger" });
    expect(isReadyForNotify(s, git, noReview, noBlocked, NOW)).toBe(false);
  });

  test("checks:none WITHOUT noCi + idle + handoff=merger → stays active (handoff ignored)", () => {
    // A CI repo's pre-green 'none' is NOT greenIdle, so handoffStage never runs → 'active'.
    const s = makeSession({ status: "idle" });
    const git = makeGit({ state: "open", checks: "none", handoff: "merger" });
    expect(isReadyForNotify(s, git, noReview, noBlocked, NOW)).toBe(true);
  });

  test("open PR + checks success + idle + isDraft (draftAwaitingSignoff) → READY", () => {
    const s = makeSession({ status: "idle" });
    const git = makeGit({ state: "open", checks: "success", isDraft: true });
    expect(isReadyForNotify(s, git, noReview, noBlocked, NOW)).toBe(true);
  });

  test("readyToMerge=true (ready stage) → READY", () => {
    const s = makeSession({ status: "idle", readyToMerge: true });
    expect(isReadyForNotify(s, undefined, noReview, noBlocked, NOW)).toBe(true);
  });

  test("mergingSince=now (merging) → NOT ready", () => {
    const s = makeSession({ status: "idle", mergingSince: NOW });
    expect(isReadyForNotify(s, undefined, noReview, noBlocked, NOW)).toBe(false);
  });

  test("git.state=merged → NOT ready (intentional delta: merged excluded)", () => {
    const s = makeSession({ status: "idle" });
    const git = makeGit({ state: "merged" });
    // Regression anchor: must fail if the merged exclusion is removed
    expect(isReadyForNotify(s, git, noReview, noBlocked, NOW)).toBe(false);
  });
});
