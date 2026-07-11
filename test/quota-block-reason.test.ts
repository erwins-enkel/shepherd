import { test, expect } from "bun:test";
import { quotaBlockReason } from "../src/blocked";
import type { Session, ReviewVerdict, PlanGate } from "../src/types";

// Minimal session fixture — only fields the function checks (status).
function makeSession(status: Session["status"] = "idle"): Session {
  return {
    id: "s1",
    desig: "TASK-01",
    name: "test",
    prompt: "do something",
    repoPath: "/repo",
    baseBranch: "main",
    branch: "feat/test",
    worktreePath: "/worktree",
    isolated: false,
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
    status,
    lastState: "idle",
    createdAt: 1000,
    updatedAt: 1000,
    archivedAt: null,
  } as Session;
}

// Minimal ReviewVerdict fixture.
function makeReview(overrides: Partial<ReviewVerdict> = {}): ReviewVerdict {
  return {
    sessionId: "s1",
    headSha: "abc123",
    patchId: "patch1",
    decision: "changes_requested",
    summary: "issues found",
    body: "## issues",
    findings: ["fix thing A"],
    addressRound: 1,
    addressCap: 3,
    streakReviews: 1,
    reviewedPatchIds: ["patch1"],
    errorRound: 0,
    finalRoundPending: false,
    finalRoundTimeoutMs: 60_000,
    seenNoteIds: [],
    updatedAt: 1000,
    ...overrides,
  };
}

// Minimal PlanGate fixture.
function makeGate(overrides: Partial<PlanGate> = {}): PlanGate {
  return {
    sessionId: "s1",
    planHash: "hash1",
    decision: "changes_requested",
    summary: "plan needs work",
    body: "## plan issues",
    findings: ["address concern X"],
    round: 1,
    cap: 5,
    approved: false,
    plan: "do stuff",
    updatedAt: 1000,
    ...overrides,
  };
}

const NOW = 10_000;

// 1. Running session that WOULD otherwise be exhausted → null.
test("running session suppresses quota block even when review is exhausted", () => {
  const session = makeSession("running");
  const review = makeReview({ addressRound: 3, addressCap: 3, finalRoundPending: false });
  expect(quotaBlockReason(session, review, null, NOW)).toBeNull();
});

// 2. Both review and gate null → null.
test("null review and gate → null", () => {
  const session = makeSession("idle");
  expect(quotaBlockReason(session, null, null, NOW)).toBeNull();
});

// 3. Review under cap → null.
test("review under cap → null", () => {
  const session = makeSession("idle");
  const review = makeReview({
    addressRound: 1,
    addressCap: 3,
    streakReviews: 1,
    errorRound: 0,
    findings: ["fix A"],
    finalRoundPending: false,
  });
  expect(quotaBlockReason(session, review, null, NOW)).toBeNull();
});

// 4. Rework stall: addressRound at cap, not finalRoundPending → quotaKind "rework".
test("rework stall → quotaKind rework with findings as tail", () => {
  const session = makeSession("idle");
  const findings = ["fix A", "fix B"];
  const review = makeReview({
    addressRound: 3,
    addressCap: 3,
    findings,
    finalRoundPending: false,
    streakReviews: 2,
    errorRound: 0,
  });
  const result = quotaBlockReason(session, review, null, NOW);
  expect(result).not.toBeNull();
  expect(result!.shape).toBe("quota");
  expect(result!.quotaKind).toBe("rework");
  expect(result!.options).toEqual([]);
  expect(result!.tail).toBe(findings);
});

// 5. "final" state (finalRoundPending true, not yet timed out) → null.
test("final state (pending, not timed out) → null", () => {
  const session = makeSession("idle");
  const review = makeReview({
    addressRound: 3,
    addressCap: 3,
    findings: ["fix A"],
    finalRoundPending: true,
    finalRoundTimeoutMs: 60_000,
    updatedAt: NOW - 1000, // 1s ago, well within timeout
  });
  expect(quotaBlockReason(session, review, null, NOW)).toBeNull();
});

// 6. Review ceiling: streakReviews >= 2*addressCap → quotaKind "review".
test("streakReviews >= 2*addressCap → quotaKind review", () => {
  const session = makeSession("idle");
  const findings = ["issue 1"];
  const review = makeReview({
    addressRound: 1,
    addressCap: 3,
    streakReviews: 6, // 2*3
    errorRound: 0,
    findings,
    finalRoundPending: false,
  });
  const result = quotaBlockReason(session, review, null, NOW);
  expect(result).not.toBeNull();
  expect(result!.shape).toBe("quota");
  expect(result!.quotaKind).toBe("review");
  expect(result!.options).toEqual([]);
  expect(result!.tail).toBe(findings);
});

// 7. Error ceiling: errorRound >= addressCap → quotaKind "error".
test("errorRound >= addressCap → quotaKind error", () => {
  const session = makeSession("idle");
  const findings = ["error stuff"];
  const review = makeReview({
    addressRound: 0,
    addressCap: 3,
    streakReviews: 1,
    errorRound: 3,
    findings,
    finalRoundPending: false,
  });
  const result = quotaBlockReason(session, review, null, NOW);
  expect(result).not.toBeNull();
  expect(result!.shape).toBe("quota");
  expect(result!.quotaKind).toBe("error");
  expect(result!.options).toEqual([]);
  expect(result!.tail).toBe(findings);
});

// 8. Precedence: satisfies BOTH error and rework → "error" wins.
test("error takes precedence over rework when both conditions met", () => {
  const session = makeSession("idle");
  const review = makeReview({
    addressRound: 3,
    addressCap: 3,
    streakReviews: 1,
    errorRound: 3, // >= cap → error
    findings: ["issue"],
    finalRoundPending: false, // also rework stall
  });
  const result = quotaBlockReason(session, review, null, NOW);
  expect(result!.quotaKind).toBe("error");
});

// 9. Plan gate: decision changes_requested, round === cap → quotaKind "plan".
test("plan gate exhausted → quotaKind plan with gate findings as tail", () => {
  const session = { ...makeSession("idle"), planPhase: "planning" as const };
  const findings = ["address concern X"];
  const gate = makeGate({ decision: "changes_requested", round: 5, cap: 5, findings });
  const result = quotaBlockReason(session, null, gate, NOW);
  expect(result).not.toBeNull();
  expect(result!.shape).toBe("quota");
  expect(result!.quotaKind).toBe("plan");
  expect(result!.options).toEqual([]);
  expect(result!.tail).toBe(findings);
});

// 10. Plan gate approved or under cap → null.
test("plan gate approved → null", () => {
  const session = makeSession("idle");
  const gate = makeGate({ decision: "approved", round: 5, cap: 5 });
  expect(quotaBlockReason(session, null, gate, NOW)).toBeNull();
});

test("plan gate changes_requested but round under cap → null", () => {
  const session = makeSession("idle");
  const gate = makeGate({ decision: "changes_requested", round: 3, cap: 5 });
  expect(quotaBlockReason(session, null, gate, NOW)).toBeNull();
});
