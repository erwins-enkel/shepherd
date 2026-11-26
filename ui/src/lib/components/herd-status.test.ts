import { test, expect } from "vitest";
import { herdStatusOf, countHerdStatuses, type HerdStatusCtx } from "./herd-status";
import type { Session, GitState, SessionStatus } from "#lib/types.js";

function session(id: string, status: SessionStatus, over: Partial<Session> = {}): Session {
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
    lastState: "",
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    haltReason: null,
    haltedAt: null,
    manualSteps: [],
    manualStepsAckedAt: null,
    experimentId: null,
    experimentRole: null,
    ...over,
  };
}

const green: GitState = {
  kind: "github",
  state: "open",
  checks: "success",
  deployConfigured: false,
};
const pending: GitState = { ...green, checks: "pending" };

function ctx(over: Partial<HerdStatusCtx> = {}): HerdStatusCtx {
  return {
    git: {},
    isReviewing: () => false,
    isReworkRunning: () => false,
    workingBlocked: {},
    backgroundBusy: {},
    now: 0,
    ...over,
  };
}

const of = (s: Session, c: Partial<HerdStatusCtx> = {}) => herdStatusOf(s, ctx(c));

test("running, blocked and idle keep their display status", () => {
  expect(of(session("r", "running"))).toBe("running");
  expect(of(session("b", "blocked"))).toBe("blocked");
  expect(of(session("i", "idle"))).toBe("idle");
});

test("a resting session on a green handed-off PR is Merge, never Idle", () => {
  expect(of(session("i", "idle"), { git: { i: green } })).toBe("merge");
  // herdr's finished-turn status rests too
  expect(of(session("d", "done"), { git: { d: green } })).toBe("merge");
});

test("the operator's ready flag is Merge while resting, Running while working", () => {
  expect(of(session("i", "idle", { readyToMerge: true }))).toBe("merge");
  expect(of(session("d", "done", { readyToMerge: true }))).toBe("merge");
  expect(of(session("r", "running", { readyToMerge: true }))).toBe("running");
});

test("a green PR still in flight is not Merge", () => {
  // a critic run in flight → reviewerRunning, not awaitingMerge
  expect(of(session("i", "idle"), { git: { i: green }, isReviewing: () => true })).toBe("idle");
  expect(of(session("i", "idle"), { git: { i: pending } })).toBe("idle");
  // a draft awaits sign-off, a foreign merger waits on someone else
  expect(of(session("i", "idle"), { git: { i: { ...green, isDraft: true } } })).toBe("idle");
  expect(of(session("i", "idle"), { git: { i: { ...green, handoff: "merger" } } })).toBe("idle");
});

test("a done session without a Merge stage counts nowhere, as before", () => {
  expect(of(session("d", "done"))).toBeNull();
  expect(of(session("a", "archived"))).toBeNull();
});

test("shelved sessions count only while running", () => {
  expect(of(session("s", "idle", { shelved: true }))).toBeNull();
  expect(of(session("s", "blocked", { shelved: true }))).toBeNull();
  expect(of(session("s", "idle", { shelved: true }), { git: { s: green } })).toBeNull();
  expect(of(session("s", "running", { shelved: true }))).toBe("running");
});

test("display flags upgrade to Running before the Merge check", () => {
  expect(of(session("b", "blocked"), { workingBlocked: { b: true } })).toBe("running");
  expect(of(session("d", "done"), { git: { d: green }, backgroundBusy: { d: true } })).toBe(
    "running",
  );
});

test("a mirrored session reads its own PR state and no display flags", () => {
  const host = { instanceId: "m1", name: "Mac", platform: "macos" };
  const remote = session("m", "idle", { host, git: green });
  expect(of(remote)).toBe("merge");
  // the store maps never apply to it, even under a colliding id
  expect(of(remote, { git: { m: pending }, backgroundBusy: { m: true } })).toBe("merge");
});

test("countHerdStatuses partitions the counted sessions", () => {
  const sessions = [
    session("r", "running"),
    session("i", "idle"),
    session("m", "done"),
    session("b", "blocked"),
    session("x", "done"),
  ];
  expect(countHerdStatuses(sessions, ctx({ git: { m: green } }))).toEqual({
    running: 1,
    idle: 1,
    blocked: 1,
    merge: 1,
  });
});
