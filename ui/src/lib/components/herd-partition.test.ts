import { test, expect } from "vitest";
import { partitionSessions, shownSessions } from "./herd-partition";
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
    mergingSince: null,
    mergingTrainId: null,
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

test("merging sessions land in merging, pulled out of ready; merged still wins", () => {
  const now = 1_000_000_000;
  const m1 = { ...session("m1", true), mergingSince: now - 1000, mergingTrainId: "t" };
  const m2 = { ...session("m2", true), mergingSince: now - 1000, mergingTrainId: "t" };
  const list = [session("r1", true), m1, m2];
  const { ready, merging } = partitionSessions(list, { m2: git("merged") }, () => false, now);
  expect(merging.map((s) => s.id)).toEqual(["m1"]); // m2 merged → merged group
  expect(ready.map((s) => s.id)).toEqual(["r1"]);
});

// ── repo roles: handoff routes a green PR away from "your turn" ──
function gitHandoff(handoff: "reviewer" | "merger", who: string): GitState {
  return { ...git("open", "success"), handoff, handoffWho: who };
}

test("green PR with merger handoff lands in waitingOnMerger, not awaitingMerge", () => {
  const list = [session("s", false, "idle")];
  const { awaitingMerge, waitingOnMerger } = partitionSessions(list, {
    s: gitHandoff("merger", "scoop"),
  });
  expect(awaitingMerge).toHaveLength(0);
  expect(waitingOnMerger.map((s) => s.id)).toEqual(["s"]);
});

test("green PR with reviewer handoff lands in waitingOnReviewer", () => {
  const list = [session("s", false, "idle")];
  const { awaitingMerge, waitingOnReviewer } = partitionSessions(list, {
    s: gitHandoff("reviewer", "scoop"),
  });
  expect(awaitingMerge).toHaveLength(0);
  expect(waitingOnReviewer.map((s) => s.id)).toEqual(["s"]);
});

test("green PR with no handoff still lands in awaitingMerge (self / no roles)", () => {
  const list = [session("s", false, "idle")];
  const { awaitingMerge, waitingOnMerger, waitingOnReviewer } = partitionSessions(list, {
    s: git("open", "success"),
  });
  expect(awaitingMerge.map((s) => s.id)).toEqual(["s"]);
  expect(waitingOnMerger).toHaveLength(0);
  expect(waitingOnReviewer).toHaveLength(0);
});

test("a running agent ignores handoff and stays active (not yet handed off)", () => {
  const list = [session("c", false, "running")];
  const { active, waitingOnMerger } = partitionSessions(list, { c: gitHandoff("merger", "scoop") });
  expect(waitingOnMerger).toHaveLength(0);
  expect(active.map((s) => s.id)).toEqual(["c"]);
});

test("operator-parked ready wins over a merger handoff", () => {
  const list = [session("r", true, "idle")];
  const { ready, waitingOnMerger } = partitionSessions(list, { r: gitHandoff("merger", "scoop") });
  expect(waitingOnMerger).toHaveLength(0);
  expect(ready.map((s) => s.id)).toEqual(["r"]);
});

// ── draftAwaitingSignoff group ─────────────────────────────────────────────

function gitDraft(checks: GitState["checks"] = "success"): GitState {
  return { kind: "github", state: "open", checks, deployConfigured: false, isDraft: true };
}

test("draft + green CI + idle lands in draftAwaitingSignoff, not awaitingMerge", () => {
  const list = [session("d", false, "idle")];
  const { draftAwaitingSignoff, awaitingMerge } = partitionSessions(list, { d: gitDraft() });
  expect(draftAwaitingSignoff.map((s) => s.id)).toEqual(["d"]);
  expect(awaitingMerge).toHaveLength(0);
});

test("draft + green CI + running stays active (agent still in the loop)", () => {
  const list = [session("d", false, "running")];
  const { draftAwaitingSignoff, active, awaitingMerge } = partitionSessions(list, {
    d: gitDraft(),
  });
  expect(draftAwaitingSignoff).toHaveLength(0);
  expect(awaitingMerge).toHaveLength(0);
  expect(active.map((s) => s.id)).toEqual(["d"]);
});

test("draft + green CI + blocked stays active (awaiting operator input, not handed off)", () => {
  const list = [session("d", false, "blocked")];
  const { draftAwaitingSignoff, active, awaitingMerge } = partitionSessions(list, {
    d: gitDraft(),
  });
  expect(draftAwaitingSignoff).toHaveLength(0);
  expect(awaitingMerge).toHaveLength(0);
  expect(active.map((s) => s.id)).toEqual(["d"]);
});

test("non-draft + green CI + idle lands in awaitingMerge, not draftAwaitingSignoff (regression)", () => {
  const list = [session("s", false, "idle")];
  const { draftAwaitingSignoff, awaitingMerge } = partitionSessions(list, {
    s: git("open", "success"),
  });
  expect(draftAwaitingSignoff).toHaveLength(0);
  expect(awaitingMerge.map((s) => s.id)).toEqual(["s"]);
});

test("draft + pending CI lands in ciRunning, not draftAwaitingSignoff", () => {
  const list = [session("d", false, "idle")];
  const { ciRunning, draftAwaitingSignoff } = partitionSessions(list, {
    d: gitDraft("pending"),
  });
  expect(ciRunning.map((s) => s.id)).toEqual(["d"]);
  expect(draftAwaitingSignoff).toHaveLength(0);
});

test("draft + failed CI lands in ciFailed, not draftAwaitingSignoff", () => {
  const list = [session("d", false, "idle")];
  const { ciFailed, draftAwaitingSignoff } = partitionSessions(list, {
    d: gitDraft("failure"),
  });
  expect(ciFailed.map((s) => s.id)).toEqual(["d"]);
  expect(draftAwaitingSignoff).toHaveLength(0);
});

test('"research" filter returns only sessions with research === true', () => {
  const r1 = { ...session("r1"), research: true };
  const r2 = { ...session("r2"), research: true };
  const n1 = session("n1"); // research: false by default
  const shown = shownSessions([r1, n1, r2], "research", () => false);
  expect(shown.map((s) => s.id)).toEqual(["r1", "r2"]);
});

test('"research" filter excludes all sessions when none are research', () => {
  const shown = shownSessions([session("a"), session("b")], "research", () => false);
  expect(shown).toHaveLength(0);
});

test('"all" filter is unaffected by research flag (regression)', () => {
  const r1 = { ...session("r1"), research: true };
  const n1 = session("n1");
  const shown = shownSessions([r1, n1], "all", () => false);
  expect(shown).toHaveLength(2);
});

test('"ready" filter is unaffected by research flag (regression)', () => {
  const r1 = { ...session("r1", false, "idle"), research: true };
  const n1 = { ...session("n1", false, "idle"), research: false };
  const running = session("run"); // running → dropped by ready
  const shown = shownSessions([r1, n1, running], "ready", () => false);
  expect(shown.map((s) => s.id)).toEqual(["r1", "n1"]);
});

test('"ready" filter drops a working-while-blocked session like a running one', () => {
  const list = [
    session("run"), // running → dropped
    session("wb", false, "blocked"), // blocked but flagged working → dropped
    session("blk", false, "blocked"), // genuinely blocked → kept
    session("idl", false, "idle"), // idle → kept
  ];
  const shown = shownSessions(list, "ready", () => false, { wb: true });
  expect(shown.map((s) => s.id)).toEqual(["blk", "idl"]);
  // without the flag map the blocked session stays listed
  expect(shownSessions(list, "ready", () => false).map((s) => s.id)).toEqual(["wb", "blk", "idl"]);
  // "all" ignores the flag entirely
  expect(shownSessions(list, "all", () => false, { wb: true })).toHaveLength(4);
});
