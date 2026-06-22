import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import {
  parseRundownVerdict,
  classifyAttention,
  assembleHerdState,
  buildRundownPrompt,
  fingerprintDiffCount,
  attentionFingerprint,
  isMerging,
  MERGE_MARK_BACKSTOP_MS,
  RUNDOWN_LABEL_MAX,
  RUNDOWN_DECISIONS_CAP,
  RUNDOWN_FOCUSNEXT_CAP,
  type ClassifyCaches,
} from "../src/rundown-core";
import type { Session } from "../src/types";
import type { GitState } from "../src/forge/types";

const NOW = 1_000_000_000;

function session(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    desig: "TASK-01",
    name: "task",
    prompt: "",
    repoPath: "/repo",
    baseBranch: "main",
    branch: "feat",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "h",
    herdrAgentId: "a",
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
    autoMergeEnabled: null,
    autoMergeRebaseCount: 0,
    autoMergeRebaseHead: null,
    auto: false,
    issueNumber: null,
    sandboxApplied: null,
    sandboxDegraded: false,
    egressApplied: false,
    egressDegraded: false,
    status: "running",
    lastState: "working",
    createdAt: NOW - 1000,
    updatedAt: NOW,
    archivedAt: null,
    haltReason: null,
    haltedAt: null,
    ...over,
  };
}

const git = (over: Partial<GitState> = {}): GitState =>
  ({ kind: "github", state: "open", checks: "none", deployConfigured: false, ...over }) as GitState;

// ── parseRundownVerdict ──────────────────────────────────────────────────────

test("parseRundownVerdict: valid full verdict parses", () => {
  const v = parseRundownVerdict(
    JSON.stringify({
      overnight: "2 PRs merged overnight",
      decisions: [{ label: "Answer the auth question", sessionId: "s1" }],
      ciRework: [{ label: "CI red on TASK-03", pr: 42 }],
      train: "1 ready PR waiting",
      focusNext: [{ label: "Review the migration" }],
    }),
  );
  expect(v).not.toBeNull();
  expect(v?.overnight).toBe("2 PRs merged overnight");
  expect(v?.decisions).toEqual([{ label: "Answer the auth question", sessionId: "s1" }]);
  expect(v?.ciRework).toEqual([{ label: "CI red on TASK-03", pr: 42 }]);
  expect(v?.train).toBe("1 ready PR waiting");
  expect(v?.focusNext).toEqual([{ label: "Review the migration" }]);
});

test("parseRundownVerdict: over-long label clamped", () => {
  const long = "x".repeat(RUNDOWN_LABEL_MAX + 50);
  const v = parseRundownVerdict(JSON.stringify({ decisions: [{ label: long }] }));
  expect(v!.decisions[0]!.label.length).toBe(RUNDOWN_LABEL_MAX);
});

test("parseRundownVerdict: >cap decisions sliced, >cap focusNext sliced", () => {
  const decisions = Array.from({ length: 10 }, (_, i) => ({ label: `d${i}` }));
  const focusNext = Array.from({ length: 8 }, (_, i) => ({ label: `f${i}` }));
  const v = parseRundownVerdict(JSON.stringify({ decisions, focusNext }));
  expect(v?.decisions.length).toBe(RUNDOWN_DECISIONS_CAP);
  expect(v?.focusNext.length).toBe(RUNDOWN_FOCUSNEXT_CAP);
});

test("parseRundownVerdict: malformed item dropped, missing fields defaulted", () => {
  const v = parseRundownVerdict(
    JSON.stringify({
      decisions: [{ label: "keep" }, { nolabel: true }, { label: "" }, "string-not-object", 5],
    }),
  );
  expect(v?.decisions).toEqual([{ label: "keep" }]);
  expect(v?.overnight).toBe("");
  expect(v?.train).toBe("");
  expect(v?.ciRework).toEqual([]);
  expect(v?.focusNext).toEqual([]);
});

test("parseRundownVerdict: empty / non-object / unparseable → null", () => {
  expect(parseRundownVerdict("")).toBeNull();
  expect(parseRundownVerdict("not json")).toBeNull();
  expect(parseRundownVerdict("[1,2,3]")).toBeNull();
  expect(parseRundownVerdict("null")).toBeNull();
  expect(parseRundownVerdict('"a string"')).toBeNull();
});

// ── classifyAttention ────────────────────────────────────────────────────────

test("classifyAttention: each signal maps to the correct tier", () => {
  const c = (s: Session, caches: ClassifyCaches = {}) => classifyAttention(s, caches, NOW);

  expect(c(session({ status: "blocked" }))).toMatchObject({
    tier: 1,
    signals: ["blocked-decision"],
  });
  expect(c(session({ autopilotPaused: true, autopilotQuestion: "which?" })).signals).toContain(
    "blocked-decision",
  );
  expect(
    c(session({ planPhase: "planning" }), { gate: { decision: "changes_requested" } as any }).tier,
  ).toBe(1);
  expect(c(session(), { review: { decision: "changes_requested" } as any }).tier).toBe(1);
  expect(c(session({ status: "idle" }), { git: git({ checks: "failure" }) }).tier).toBe(1);

  expect(c(session({ status: "idle" }), { git: git({ handoff: "merger" }) }).tier).toBe(2);
  expect(c(session({ status: "idle" }), { git: git({ handoff: "merger" }) }).signals).toContain(
    "awaiting-merge",
  );
  expect(c(session({ status: "idle" }), { stalled: true }).tier).toBe(2);
  expect(
    c(session({ status: "idle" }), { recap: { verdict: "needs_attention" } as any }).tier,
  ).toBe(2);
  expect(c(session({ status: "idle" }), { train: { error: true } }).tier).toBe(2);

  expect(c(session({ status: "running" })).signals).toContain("in-flight");
  expect(c(session({ status: "running" })).tier).toBe(3);
  expect(c(session({ status: "done" })).tier).toBeNull();
});

test("classifyAttention: ci-red + ready-merge resolves to tier 1 (most urgent wins)", () => {
  const r = classifyAttention(
    session({ status: "idle", readyToMerge: true }),
    { git: git({ checks: "failure" }) },
    NOW,
  );
  expect(r.tier).toBe(1);
  expect(r.signals).toContain("ci-red");
  expect(r.signals).toContain("ready-merge");
});

test("classifyAttention: readyToMerge without merger handoff → ready-merge (tier 3)", () => {
  const r = classifyAttention(session({ status: "idle", readyToMerge: true }), {}, NOW);
  expect(r.tier).toBe(3);
  expect(r.signals).toContain("ready-merge");
  expect(r.signals).not.toContain("awaiting-merge");
});

test("classifyAttention: merger handoff → awaiting-merge (tier 2), not ready-merge", () => {
  // readyToMerge set too, but handoff to merger promotes it to Tier 2.
  const r = classifyAttention(
    session({ status: "idle", readyToMerge: true }),
    { git: git({ handoff: "merger" }) },
    NOW,
  );
  expect(r.tier).toBe(2);
  expect(r.signals).toContain("awaiting-merge");
  expect(r.signals).not.toContain("ready-merge");
});

// ── assembleHerdState — Tier-1 never dropped by top-N ─────────────────────────

test("assembleHerdState: Tier-1 always kept, only Tier-3 dropped, truncatedTier3 set", () => {
  const sessions: Session[] = [];
  // 3 Tier-1 (blocked)
  for (let i = 0; i < 3; i++)
    sessions.push(session({ id: `t1-${i}`, desig: `T1-${i}`, status: "blocked" }));
  // 10 Tier-3 (running, in-flight only)
  for (let i = 0; i < 10; i++)
    sessions.push(session({ id: `t3-${i}`, desig: `T3-${i}`, status: "running" }));

  const out = assembleHerdState({
    sessions,
    overnightDelta: { mergedPrs: [], archivedSessions: [] },
    generatedFor: "2026-06-15",
    now: NOW,
    topN: 5, // budget: 3 tier1 forced + 2 tier3 → 8 tier3 dropped
  });

  const keptIds = out.sessions.map((s) => s.sessionId);
  for (let i = 0; i < 3; i++) expect(keptIds).toContain(`t1-${i}`);
  expect(out.sessions.filter((s) => s.tier === 1).length).toBe(3);
  expect(out.sessions.filter((s) => s.tier === 3).length).toBe(2);
  expect(out.truncatedTier3).toBe(8);
  // Tier-1 first in output
  expect(out.sessions[0]!.tier).toBe(1);
});

test("assembleHerdState: Tier-1 overflow drops a Tier-2, truncatedTier2 set", () => {
  const sessions: Session[] = [];
  // 3 Tier-1 (blocked)
  for (let i = 0; i < 3; i++)
    sessions.push(session({ id: `t1-${i}`, desig: `T1-${i}`, status: "blocked" }));
  // 2 Tier-2 (stalled)
  for (let i = 0; i < 2; i++)
    sessions.push(session({ id: `t2-${i}`, desig: `T2-${i}`, status: "idle" }));

  const out = assembleHerdState({
    sessions,
    stalled: new Set(["t2-0", "t2-1"]),
    overnightDelta: { mergedPrs: [], archivedSessions: [] },
    generatedFor: "2026-06-15",
    now: NOW,
    topN: 3, // budget: 3 tier1 forced, 0 left → both tier2 dropped
  });

  expect(out.sessions.filter((s) => s.tier === 1).length).toBe(3);
  expect(out.sessions.filter((s) => s.tier === 2).length).toBe(0);
  expect(out.truncatedTier2).toBe(2);
  expect(out.truncatedTier3).toBe(0);
});

test("buildRundownPrompt: not-all-clear guard fires when truncatedTier2>0 with truncatedTier3==0", () => {
  const sessions: Session[] = [];
  for (let i = 0; i < 3; i++)
    sessions.push(session({ id: `t1-${i}`, desig: `T1-${i}`, status: "blocked" }));
  sessions.push(session({ id: "t2-0", desig: "T2-0", status: "idle" }));

  const out = assembleHerdState({
    sessions,
    stalled: new Set(["t2-0"]),
    overnightDelta: { mergedPrs: [], archivedSessions: [] },
    generatedFor: "2026-06-15",
    now: NOW,
    topN: 3,
  });
  expect(out.truncatedTier2).toBe(1);
  expect(out.truncatedTier3).toBe(0);

  const prompt = buildRundownPrompt(out);
  expect(prompt).toContain('do NOT claim "all clear"');
  expect(prompt).toContain("Tier-2 (HIGH)");
});

// ── assembleHerdState — backlog-priority weighting ────────────────────────────

test("assembleHerdState: within a tier, higher-priority repo (lower backlogRank) sorts first", () => {
  // Same tier (both Tier-3, in-flight), same age — only backlogRank should break the tie.
  const sessions: Session[] = [
    session({ id: "lo", desig: "LO", repoPath: "/repo-low", status: "running" }),
    session({ id: "hi", desig: "HI", repoPath: "/repo-high", status: "running" }),
  ];
  const out = assembleHerdState({
    sessions,
    overnightDelta: { mergedPrs: [], archivedSessions: [] },
    generatedFor: "2026-06-15",
    now: NOW,
    backlogRank: { "/repo-high": 0, "/repo-low": 1 },
  });
  expect(out.sessions.map((s) => s.sessionId)).toEqual(["hi", "lo"]);
});

test("assembleHerdState: backlogRank does NOT promote a Tier-3 above a Tier-1", () => {
  const sessions: Session[] = [
    // Tier-3 in a top-priority repo (rank 0)
    session({ id: "t3", desig: "T3", repoPath: "/repo-high", status: "running" }),
    // Tier-1 in a no-priority repo
    session({ id: "t1", desig: "T1", repoPath: "/repo-none", status: "blocked" }),
  ];
  const out = assembleHerdState({
    sessions,
    overnightDelta: { mergedPrs: [], archivedSessions: [] },
    generatedFor: "2026-06-15",
    now: NOW,
    backlogRank: { "/repo-high": 0 },
  });
  // Tier-1 must lead despite the Tier-3 living in the higher-priority repo.
  expect(out.sessions[0]!.sessionId).toBe("t1");
  expect(out.sessions[0]!.tier).toBe(1);
});

test("assembleHerdState: emitted sessions carry backlogRank (ranked + sentinel for unranked)", () => {
  const sessions: Session[] = [
    session({ id: "ranked", desig: "R", repoPath: "/repo-high", status: "running" }),
    session({ id: "unranked", desig: "U", repoPath: "/repo-other", status: "running" }),
  ];
  const out = assembleHerdState({
    sessions,
    overnightDelta: { mergedPrs: [], archivedSessions: [] },
    generatedFor: "2026-06-15",
    now: NOW,
    backlogRank: { "/repo-high": 3 },
  });
  const byId = Object.fromEntries(out.sessions.map((s) => [s.sessionId, s.backlogRank]));
  expect(byId.ranked).toBe(3);
  expect(byId.unranked).toBe(Number.MAX_SAFE_INTEGER);
});

test("assembleHerdState: backlogRank absent → all sessions get the sentinel, age tiebreaks", () => {
  const sessions: Session[] = [
    session({ id: "young", desig: "Y", status: "running", createdAt: NOW - 100 }),
    session({ id: "old", desig: "O", status: "running", createdAt: NOW - 5000 }),
  ];
  const out = assembleHerdState({
    sessions,
    overnightDelta: { mergedPrs: [], archivedSessions: [] },
    generatedFor: "2026-06-15",
    now: NOW,
  });
  expect(out.sessions.every((s) => s.backlogRank === Number.MAX_SAFE_INTEGER)).toBe(true);
  // Equal sentinel rank → oldest first.
  expect(out.sessions.map((s) => s.sessionId)).toEqual(["old", "young"]);
});

test("buildRundownPrompt: states backlog-priority preference for focusNext", () => {
  const out = assembleHerdState({
    sessions: [session({ id: "s", desig: "S", status: "running" })],
    overnightDelta: { mergedPrs: [], archivedSessions: [] },
    generatedFor: "2026-06-15",
    now: NOW,
  });
  const prompt = buildRundownPrompt(out);
  expect(prompt).toContain("backlogRank");
  expect(prompt).toContain("focusNext");
  expect(prompt).toContain("higher-priority repos");
});

// ── fingerprint diff ─────────────────────────────────────────────────────────

test("attentionFingerprint: only attention-bearing sessions, sorted signals", () => {
  const fp = attentionFingerprint([
    { sessionId: "a", signals: ["in-flight", "ci-red"] },
    { sessionId: "b", signals: [] },
  ]);
  expect(fp).toEqual({ a: ["ci-red", "in-flight"] });
});

test("fingerprintDiffCount: appear / clear / change each count 1; identical → 0", () => {
  const base = { x: ["in-flight"], y: ["awaiting-merge"] };
  expect(fingerprintDiffCount(base, base)).toBe(0);
  // ci-red appears on a new session z
  expect(fingerprintDiffCount(base, { ...base, z: ["ci-red"] })).toBe(1);
  // a bottleneck clears (y removed)
  expect(fingerprintDiffCount(base, { x: ["in-flight"] })).toBe(1);
  // a signal changes on x
  expect(fingerprintDiffCount(base, { x: ["ci-red"], y: ["awaiting-merge"] })).toBe(1);
});

// ── merge-mark backstop parity (DRIFT lock) ──────────────────────────────────

test("MERGE_MARK_BACKSTOP_MS matches the UI constant", () => {
  // Reads the UI literal and evaluates it WITHOUT eval: the expression is a chain of
  // numeric multiplications (e.g. `24 * 60 * 60_000`), so we parse the operands and
  // multiply them ourselves. This locks the server const to the UI const (the DRIFT pair).
  const ui = readFileSync(
    new URL("../ui/src/lib/components/merge-train.ts", import.meta.url),
    "utf8",
  );
  const m = ui.match(/MERGE_MARK_BACKSTOP_MS\s*=\s*([^;]+);/);
  expect(m).not.toBeNull();
  const expr = m![1]!.trim();
  expect(/^[\d_\s*]+$/.test(expr)).toBe(true); // pure numeric-multiply chain, no eval needed
  const uiValue = expr
    .split("*")
    .map((p) => Number(p.replace(/_/g, "").trim()))
    .reduce((a, b) => a * b, 1);
  expect(MERGE_MARK_BACKSTOP_MS).toBe(uiValue);
});

test("isMerging: marked within backstop true, beyond false, unmarked false", () => {
  expect(isMerging({ mergingSince: NOW - 1000 }, NOW)).toBe(true);
  expect(isMerging({ mergingSince: NOW - MERGE_MARK_BACKSTOP_MS - 1 }, NOW)).toBe(false);
  expect(isMerging({ mergingSince: null }, NOW)).toBe(false);
});

// ── retained gate is inert during execution (issue #809) ─────────────────────

import type { PlanGate } from "../src/types";

const retainedAtCapGate: PlanGate = {
  sessionId: "s1",
  planHash: "abc",
  decision: "changes_requested",
  summary: "needs rework",
  body: "## issues",
  findings: ["fix X", "address Y"],
  round: 3,
  cap: 3,
  approved: false,
  plan: "do stuff",
  updatedAt: 1000,
};

test("classifyAttention + assemble: executing session with retained gate has no plan-rework signal and no planRound", () => {
  // An executing session whose retained gate is changes_requested at cap must NOT get the
  // plan-rework signal and must NOT have planRound set. Both L91 and L251 must be guarded.
  const executingSession = session({ planPhase: "executing", status: "idle" });
  const caches: ClassifyCaches = { gate: retainedAtCapGate };

  const attn = classifyAttention(executingSession, caches, NOW);
  expect(attn.signals).not.toContain("plan-rework"); // L91 guard

  // assembleHerdState to check planRound (L251 guard)
  const out = assembleHerdState({
    sessions: [executingSession],
    gates: { s1: retainedAtCapGate },
    overnightDelta: { mergedPrs: [], archivedSessions: [] },
    generatedFor: "2026-06-19",
    now: NOW,
  });
  const item = out.sessions.find((s) => s.sessionId === "s1");
  // The session must still appear (it has an in-flight signal from idle status + some tier).
  // planRound must be absent — the retained gate must not leak planRound into execution.
  expect(item?.planRound).toBeUndefined(); // L251 guard
});

test("classifyAttention + assemble: planning session with same at-cap gate still gets plan-rework + planRound (guard not over-suppressing)", () => {
  // Contrast: planPhase:"planning" with the same gate must still produce plan-rework and planRound.
  const planningSession = session({ planPhase: "planning", status: "idle" });
  const caches: ClassifyCaches = { gate: retainedAtCapGate };

  const attn = classifyAttention(planningSession, caches, NOW);
  expect(attn.signals).toContain("plan-rework"); // still fires during planning

  const out = assembleHerdState({
    sessions: [planningSession],
    gates: { s1: retainedAtCapGate },
    overnightDelta: { mergedPrs: [], archivedSessions: [] },
    generatedFor: "2026-06-19",
    now: NOW,
  });
  const item = out.sessions.find((s) => s.sessionId === "s1");
  expect(item?.planRound).toBe(3); // planRound still set during planning
});
