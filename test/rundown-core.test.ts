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
  RUNDOWN_EPICS_CAP,
  explainHold,
  planQuestionsUnanswered,
  type ClassifyCaches,
} from "../src/rundown-core";
import type { Session } from "../src/types";
import type { GitState } from "../src/forge/types";
import type { BlockReason } from "../src/blocked";

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
    effort: null,
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
    landingRepair: false,
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
    manualSteps: [],
    manualStepsAckedAt: null,
    experimentId: null,
    experimentRole: null,
    spawnTerminalId: null,
    spawnAccountDir: null,
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
  // Parked (idle) plan-rework is the operator's turn → Tier-1.
  expect(
    c(session({ planPhase: "planning", status: "idle" }), {
      gate: { decision: "changes_requested", round: 1, cap: 3 } as any,
    }).tier,
  ).toBe(1);
  // Running plan-rework is the AGENT's turn (revising) → no plan-rework signal, in-flight Tier-3 (#1629).
  const runningRevise = c(session({ planPhase: "planning", status: "running" }), {
    gate: { decision: "changes_requested", round: 1, cap: 3 } as any,
  });
  expect(runningRevise.signals).not.toContain("plan-rework");
  expect(runningRevise.tier).toBe(3);
  expect(
    explainHold(
      session({ planPhase: "planning", status: "running" }),
      { gate: { decision: "changes_requested", round: 1, cap: 3 } as any },
      NOW,
    ),
  ).toBeNull();
  expect(
    c(session(), {
      review: {
        decision: "changes_requested",
        findings: ["f"],
        addressRound: 1,
        addressCap: 3,
      } as any,
    }).tier,
  ).toBe(1);
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

// ── manual operator steps signal (#1060) ─────────────────────────────────────

const mstep = (text: string, postMerge = false) => ({ id: "ms1", text, postMerge });

test("classifyAttention: un-acked non-POST-MERGE step on an open PR → manual-steps (tier 1)", () => {
  const r = classifyAttention(
    session({ status: "idle", manualSteps: [mstep("flip the flag")], manualStepsAckedAt: null }),
    { git: git() },
    NOW,
  );
  expect(r.tier).toBe(1);
  expect(r.signals).toContain("manual-steps");
});

test("classifyAttention: acked steps → no manual-steps signal", () => {
  const r = classifyAttention(
    session({ status: "idle", manualSteps: [mstep("flip the flag")], manualStepsAckedAt: 123 }),
    { git: git() },
    NOW,
  );
  expect(r.signals).not.toContain("manual-steps");
});

test("classifyAttention: POST-MERGE-only steps → no manual-steps signal", () => {
  const r = classifyAttention(
    session({ status: "idle", manualSteps: [mstep("run the backfill", true)] }),
    { git: git() },
    NOW,
  );
  expect(r.signals).not.toContain("manual-steps");
});

test("classifyAttention: steps but no open PR → no manual-steps signal (gate is moot)", () => {
  const r = classifyAttention(
    session({ status: "idle", manualSteps: [mstep("flip the flag")] }),
    { git: git({ state: "merged" }) },
    NOW,
  );
  expect(r.signals).not.toContain("manual-steps");
});

test("explainHold: manual-steps → hold reason with the non-POST-MERGE step count", () => {
  const hold = explainHold(
    session({
      status: "idle",
      manualSteps: [mstep("flip the flag"), mstep("run the backfill", true), mstep("seed a row")],
    }),
    { git: git() },
    NOW,
  );
  expect(hold).toEqual({ code: "manual-steps", params: { steps: 2 } });
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

test("plan-rework: running suppresses the signal + planRound (agent's turn), regardless of stall; idle keeps both", () => {
  // A RUNNING session is the AGENT's turn (revising the plan), so it never gets plan-rework —
  // whether the streak is at-cap/stalled or mid-round (#1629). It falls to in-flight (Tier-3).
  const gate = { ...retainedAtCapGate };
  // RUNNING at-cap session: no plan-rework, no planRound (reads as active work).
  const running = classifyAttention(
    session({ planPhase: "planning", status: "running" }),
    { gate },
    NOW,
  );
  expect(running.signals).not.toContain("plan-rework");
  expect(running.signals).toContain("in-flight");
  expect(running.tier).toBe(3);
  // RUNNING below-cap (mid-round) session: still the agent's turn → no plan-rework either.
  const runningMidRound = classifyAttention(
    session({ planPhase: "planning", status: "running" }),
    { gate: { ...retainedAtCapGate, round: 1, cap: 3 } },
    NOW,
  );
  expect(runningMidRound.signals).not.toContain("plan-rework");
  expect(runningMidRound.tier).toBe(3);
  const runOut = assembleHerdState({
    sessions: [session({ planPhase: "planning", status: "running" })],
    gates: { s1: gate },
    overnightDelta: { mergedPrs: [], archivedSessions: [] },
    generatedFor: "2026-06-19",
    now: NOW,
  });
  expect(runOut.sessions.find((s) => s.sessionId === "s1")?.planRound).toBeUndefined();
  // IDLE genuinely-stalled session: plan-rework + planRound preserved (needs a human).
  const idle = classifyAttention(session({ planPhase: "planning", status: "idle" }), { gate }, NOW);
  expect(idle.signals).toContain("plan-rework");
  const idleOut = assembleHerdState({
    sessions: [session({ planPhase: "planning", status: "idle" })],
    gates: { s1: gate },
    overnightDelta: { mergedPrs: [], archivedSessions: [] },
    generatedFor: "2026-06-19",
    now: NOW,
  });
  expect(idleOut.sessions.find((s) => s.sessionId === "s1")?.planRound).toBe(3);
});

test("plan-rework: a dismissed gate suppresses the signal even when idle", () => {
  const gate: PlanGate = { ...retainedAtCapGate, round: 1, cap: 3, dismissed: true };
  const idle = classifyAttention(session({ planPhase: "planning", status: "idle" }), { gate }, NOW);
  expect(idle.signals).not.toContain("plan-rework");
});

test("critic-rework: running + stalled suppresses; dismissed suppresses; idle stall keeps it", () => {
  const stalled = {
    decision: "changes_requested",
    findings: ["f"],
    addressRound: 3,
    addressCap: 3,
    finalRoundPending: false,
    updatedAt: NOW,
  } as any;
  expect(
    classifyAttention(session({ status: "running" }), { review: stalled }, NOW).signals,
  ).not.toContain("critic-rework");
  expect(
    classifyAttention(session({ status: "idle" }), { review: stalled }, NOW).signals,
  ).toContain("critic-rework");
  expect(
    classifyAttention(session({ status: "idle" }), { review: { ...stalled, dismissed: true } }, NOW)
      .signals,
  ).not.toContain("critic-rework");
});

test("critic-rework: verdict for an OLDER head (rework pushed, PR open at newer head) is suppressed", () => {
  const review = {
    decision: "changes_requested",
    findings: ["f"],
    headSha: "oldsha",
    addressRound: 1,
    addressCap: 3,
    finalRoundPending: false,
    updatedAt: NOW,
  } as any;
  const staleGit = {
    kind: "github",
    state: "open",
    checks: "pending",
    headSha: "newsha",
    deployConfigured: false,
  } as GitState;
  // stale: verdict head ≠ the PR's current open head → not active rework
  expect(
    classifyAttention(session({ status: "idle" }), { review, git: staleGit }, NOW).signals,
  ).not.toContain("critic-rework");
  // live: verdict head === current head → still active rework
  expect(
    classifyAttention(
      session({ status: "idle" }),
      { review, git: { ...staleGit, headSha: "oldsha" } },
      NOW,
    ).signals,
  ).toContain("critic-rework");
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

// ── halt classification ──────────────────────────────────────────────────────

test("classifyAttention: haltReason:error → halted-error signal, tier 1", () => {
  const r = classifyAttention(session({ haltReason: "error", status: "idle" }), {}, NOW);
  expect(r.signals).toContain("halted-error");
  expect(r.tier).toBe(1);
});

test("classifyAttention: haltReason:usage_limit → halted-usage signal, tier 2", () => {
  const r = classifyAttention(session({ haltReason: "usage_limit", status: "idle" }), {}, NOW);
  expect(r.signals).toContain("halted-usage");
  expect(r.tier).toBe(2);
});

test("classifyAttention: haltReason:operator → no halt signal", () => {
  const r = classifyAttention(session({ haltReason: "operator", status: "idle" }), {}, NOW);
  expect(r.signals).not.toContain("halted-error");
  expect(r.signals).not.toContain("halted-usage");
});

test("classifyAttention: haltReason:completed → no halt signal", () => {
  const r = classifyAttention(session({ haltReason: "completed", status: "idle" }), {}, NOW);
  expect(r.signals).not.toContain("halted-error");
  expect(r.signals).not.toContain("halted-usage");
});

// ── plan-question: unanswered plan-gate question awaiting the operator (#1332) ──

const gateWithForm = (over: Partial<PlanGate> = {}): PlanGate =>
  ({
    sessionId: "s1",
    planHash: "h",
    decision: "approved",
    summary: "",
    body: "",
    findings: [],
    round: 0,
    cap: 3,
    approved: true,
    plan: "",
    blocks: [
      {
        type: "question-form",
        id: "qf1",
        questions: [{ id: "q1", prompt: "Which?", kind: "single", options: ["a", "b"] }],
      },
    ],
    answeredQuestionKeys: [],
    updatedAt: NOW,
    ...over,
  }) as PlanGate;

test("classifyAttention: planning + unanswered question → plan-question signal, tier 1", () => {
  const r = classifyAttention(session({ planPhase: "planning" }), { gate: gateWithForm() }, NOW);
  expect(r.signals).toContain("plan-question");
  expect(r.tier).toBe(1);
});

test("classifyAttention: answered question → no plan-question signal", () => {
  const r = classifyAttention(
    session({ planPhase: "planning" }),
    { gate: gateWithForm({ answeredQuestionKeys: ["qf1 q1"] }) },
    NOW,
  );
  expect(r.signals).not.toContain("plan-question");
});

test("classifyAttention: unanswered question but executing → no plan-question signal (no leak)", () => {
  const r = classifyAttention(session({ planPhase: "executing" }), { gate: gateWithForm() }, NOW);
  expect(r.signals).not.toContain("plan-question");
});

test("classifyAttention: gate without a question-form → no plan-question signal", () => {
  const r = classifyAttention(
    session({ planPhase: "planning" }),
    { gate: gateWithForm({ blocks: [{ type: "rich-text", id: "rt", markdown: "x" }] }) },
    NOW,
  );
  expect(r.signals).not.toContain("plan-question");
});

test("explainHold: plan-question → { code: 'plan-question' }", () => {
  const hold = explainHold(session({ planPhase: "planning" }), { gate: gateWithForm() }, NOW);
  expect(hold).toEqual({ code: "plan-question" });
});

test("classifyAttention: plan-rework co-occurring with plan-question stays PRIMARY (round/cap intact)", () => {
  // A changes_requested AUTO plan whose questions are also unanswered fires both Tier-1 signals;
  // plan-question is ordered last so plan-rework remains the primary hold line with its params.
  // Parked (idle) session: plan-rework is the operator's turn, so it fires (a running session would
  // be the agent's turn and suppress plan-rework — see #1629).
  const gate = gateWithForm({ decision: "changes_requested", approved: false, round: 1, cap: 3 });
  const s = session({ planPhase: "planning", status: "idle" });
  const r = classifyAttention(s, { gate }, NOW);
  expect(r.signals).toContain("plan-rework");
  expect(r.signals).toContain("plan-question");
  // explainHold takes the FIRST non-in-flight signal → plan-rework, carrying round/cap.
  expect(explainHold(s, { gate }, NOW)).toEqual({
    code: "plan-rework",
    params: { round: 1, cap: 3 },
  });
});

test("planQuestionsUnanswered matches the shared parity fixtures (server ↔ client drift lock)", () => {
  // Same fixtures asserted by the UI's tab-signal.svelte.test.ts against its mirrored predicate;
  // any drift between the two implementations fails one suite. Mirrors the MERGE_MARK_BACKSTOP_MS lock.
  const cases = JSON.parse(
    readFileSync(new URL("./fixtures/plan-question-parity.json", import.meta.url), "utf8"),
  ) as Array<{ name: string; gate: Partial<PlanGate>; expected: boolean }>;
  for (const c of cases) {
    expect({ name: c.name, r: planQuestionsUnanswered(c.gate as PlanGate) }).toEqual({
      name: c.name,
      r: c.expected,
    });
  }
});

// ── block-aware blocked-decision ─────────────────────────────────────────────

test("classifyAttention: running session + caches.block → blocked-decision tier 1", () => {
  const block: BlockReason = {
    shape: "menu",
    options: [
      { label: "a", send: "1" },
      { label: "b", send: "2" },
    ],
    tail: [],
  };
  const r = classifyAttention(session({ status: "running" }), { block }, NOW);
  expect(r.signals).toContain("blocked-decision");
  expect(r.tier).toBe(1);
});

test("classifyAttention: running session without block → no blocked-decision", () => {
  const r = classifyAttention(session({ status: "running" }), {}, NOW);
  expect(r.signals).not.toContain("blocked-decision");
});

// ── explainHold coverage ─────────────────────────────────────────────────────

test("explainHold: blocked-decision + block:{shape:menu} → blocked-menu", () => {
  const block: BlockReason = {
    shape: "menu",
    options: [
      { label: "a", send: "1" },
      { label: "b", send: "2" },
    ],
    tail: [],
  };
  const hold = explainHold(session({ status: "running" }), { block }, NOW);
  expect(hold?.code).toBe("blocked-menu");
});

test("explainHold: blocked-decision + autopilotPaused + question → autopilot-paused with question", () => {
  const hold = explainHold(
    session({ autopilotPaused: true, autopilotQuestion: "Which approach?" }),
    {},
    NOW,
  );
  expect(hold?.code).toBe("autopilot-paused");
  expect(hold?.params?.question).toBe("Which approach?");
});

test("explainHold: plan-rework → plan-rework with round/cap from gate", () => {
  const hold = explainHold(
    session({ planPhase: "planning", status: "idle" }),
    { gate: { decision: "changes_requested", round: 2, cap: 3 } as any },
    NOW,
  );
  expect(hold?.code).toBe("plan-rework");
  expect(hold?.params?.round).toBe(2);
  expect(hold?.params?.cap).toBe(3);
});

test("explainHold: critic-rework → critic-rework with findings count", () => {
  const hold = explainHold(
    session({ status: "idle" }),
    { review: { decision: "changes_requested", findings: ["a", "b"] } as any },
    NOW,
  );
  expect(hold?.code).toBe("critic-rework");
  expect(hold?.params?.findings).toBe(2);
});

test("explainHold: ci-red → ci-red with pr when git.number set", () => {
  const hold = explainHold(
    session({ status: "idle" }),
    { git: git({ checks: "failure", number: 99 }) },
    NOW,
  );
  expect(hold?.code).toBe("ci-red");
  expect(hold?.params?.pr).toBe(99);
});

test("explainHold: merging + autoMergeRebaseHead → merge-rebasing with rebaseCount (realistic running status)", () => {
  // A merge-train session is normally running/idle; in-flight must not shadow merging.
  const hold = explainHold(
    session({
      status: "running",
      mergingSince: NOW - 1000,
      autoMergeRebaseHead: "abc123",
      autoMergeRebaseCount: 2,
    }),
    {},
    NOW,
  );
  expect(hold?.code).toBe("merge-rebasing");
  expect(hold?.params?.rebaseCount).toBe(2);
});

test("explainHold: merging + no rebaseHead + mergingPrNumber → merging pr (realistic idle status)", () => {
  // A merge-train session is normally running/idle; in-flight must not shadow merging.
  const hold = explainHold(
    session({
      status: "idle",
      mergingSince: NOW - 1000,
      autoMergeRebaseHead: null,
      mergingPrNumber: 42,
    }),
    {},
    NOW,
  );
  expect(hold?.code).toBe("merging");
  expect(hold?.params?.pr).toBe(42);
});

test("explainHold: halted-usage with resetAt in caches → halted-usage with resetAt", () => {
  const resetAt = NOW + 3600_000;
  const hold = explainHold(
    session({ haltReason: "usage_limit", status: "idle" }),
    { resetAt },
    NOW,
  );
  expect(hold?.code).toBe("halted-usage");
  expect(hold?.params?.resetAt).toBe(resetAt);
});

test("explainHold: only in-flight signal → null", () => {
  const hold = explainHold(session({ status: "running" }), {}, NOW);
  expect(hold).toBeNull();
});

test("explainHold: no signals → null", () => {
  const hold = explainHold(session({ status: "done" }), {}, NOW);
  expect(hold).toBeNull();
});

// ── rundown attach: assembleHerdState sets hold ──────────────────────────────

test("assembleHerdState: plan-rework session gets hold with correct code", () => {
  const s = session({ planPhase: "planning", status: "idle" });
  const out = assembleHerdState({
    sessions: [s],
    gates: { s1: { decision: "changes_requested", round: 1, cap: 3 } as any },
    overnightDelta: { mergedPrs: [], archivedSessions: [] },
    generatedFor: "2026-06-22",
    now: NOW,
  });
  const item = out.sessions.find((s) => s.sessionId === "s1");
  expect(item?.hold?.code).toBe("plan-rework");
});

// ── prompt render: why field ─────────────────────────────────────────────────

test("buildRundownPrompt: plan-rework session renders English 'why', raw hold object absent", () => {
  const s = session({ planPhase: "planning", status: "idle" });
  const out = assembleHerdState({
    sessions: [s],
    gates: { s1: { decision: "changes_requested", round: 1, cap: 3 } as any },
    overnightDelta: { mergedPrs: [], archivedSessions: [] },
    generatedFor: "2026-06-22",
    now: NOW,
  });
  const prompt = buildRundownPrompt(out);
  // Should contain the rendered English phrase (not the raw hold code object)
  expect(prompt).toContain("Plan review");
  // The raw hold key must not be serialized into the prompt JSON
  expect(prompt).not.toContain('"hold"');
  // The "why" key should be present instead
  expect(prompt).toContain('"why"');
});

test("buildRundownPrompt: prompt instructs model about the 'why' field and renders English phrase (not raw code)", () => {
  // Use a plan-rework session so the assembled state carries a hold → "why" in prompt JSON.
  const s = session({ planPhase: "planning", status: "idle" });
  const out = assembleHerdState({
    sessions: [s],
    gates: { s1: { decision: "changes_requested", round: 1, cap: 3 } as any },
    overnightDelta: { mergedPrs: [], archivedSessions: [] },
    generatedFor: "2026-06-22",
    now: NOW,
  });
  const prompt = buildRundownPrompt(out);
  // Instruction prose mentions the "why" field
  expect(prompt).toContain('"why"');
  // Rendered English phrase present (from renderHold, not the raw hold object)
  expect(prompt).toContain("Plan review");
  // The "hold" object must NOT appear in prompt JSON — it's replaced by the "why" string
  expect(prompt).not.toContain('"hold"');
});

// ── epics-to-land (#1045) ─────────────────────────────────────────────────────
const epic = (over: Partial<import("../src/types").RundownEpicItem> = {}) => ({
  repo: "/repo/a",
  parent: 7,
  title: "Epic A",
  landingPr: 99,
  stranded: false,
  ...over,
});

test("assembleHerdState: epics passed through (default [] when absent)", () => {
  const none = assembleHerdState({
    sessions: [],
    overnightDelta: { mergedPrs: [], archivedSessions: [] },
    generatedFor: "2026-06-15",
    now: NOW,
  });
  expect(none.epics).toEqual([]);

  const out = assembleHerdState({
    sessions: [],
    epics: [epic(), epic({ parent: 8, title: "Epic B" })],
    overnightDelta: { mergedPrs: [], archivedSessions: [] },
    generatedFor: "2026-06-15",
    now: NOW,
  });
  expect(out.epics.map((e) => e.parent)).toEqual([7, 8]);
});

test("assembleHerdState: epics sliced to RUNDOWN_EPICS_CAP", () => {
  const many = Array.from({ length: 30 }, (_, i) => epic({ parent: i }));
  const out = assembleHerdState({
    sessions: [],
    epics: many,
    overnightDelta: { mergedPrs: [], archivedSessions: [] },
    generatedFor: "2026-06-15",
    now: NOW,
  });
  expect(out.epics.length).toBe(RUNDOWN_EPICS_CAP);
});

test("buildRundownPrompt: epics surfaced in dedicated block, NOT echoed in the JSON dump", () => {
  const out = assembleHerdState({
    sessions: [],
    epics: [epic({ repo: "/repo/x", parent: 7, title: "Land me", landingPr: 99, stranded: true })],
    overnightDelta: { mergedPrs: [], archivedSessions: [] },
    generatedFor: "2026-06-15",
    now: NOW,
  });
  const prompt = buildRundownPrompt(out);
  // dedicated block present
  expect(prompt).toContain("EPICS AWAITING LANDING");
  expect(prompt).toContain("/repo/x #7");
  expect(prompt).toContain("landing PR #99");
  expect(prompt).toContain("STRANDED");
  expect(prompt).toContain("MUST NOT repeat them in");
  // the JSON herd-state dump must NOT carry an `epics` key (stripped to avoid double-injection)
  const dump = prompt.slice(prompt.indexOf("Herd state (already significance-ranked)"));
  expect(dump).not.toContain('"epics"');
});

test("buildRundownPrompt: fences the herd-state JSON dump as untrusted", () => {
  const out = assembleHerdState({
    sessions: [],
    overnightDelta: { mergedPrs: [], archivedSessions: [] },
    generatedFor: "2026-06-15",
    now: NOW,
  });
  const prompt = buildRundownPrompt(out);
  expect(prompt).toContain("⟦UNTRUSTED:herd state:");
});

test("buildRundownPrompt: no epic block when none", () => {
  const out = assembleHerdState({
    sessions: [],
    overnightDelta: { mergedPrs: [], archivedSessions: [] },
    generatedFor: "2026-06-15",
    now: NOW,
  });
  expect(buildRundownPrompt(out)).not.toContain("EPICS AWAITING LANDING");
});

// ── paused-rebase epics (#1071) ─────────────────────────────────────────────────
test("assembleHerdState: paused epic (pausedReason set) passes through to epics array", () => {
  const out = assembleHerdState({
    sessions: [],
    epics: [epic({ pausedReason: "cap" }), epic({ parent: 8, pausedReason: "driver" })],
    overnightDelta: { mergedPrs: [], archivedSessions: [] },
    generatedFor: "2026-06-15",
    now: NOW,
  });
  expect(out.epics).toHaveLength(2);
  expect(out.epics.at(0)?.pausedReason).toBe("cap");
  expect(out.epics.at(1)?.pausedReason).toBe("driver");
});

test("assembleHerdState: null pausedReason passes through (non-paused item)", () => {
  const out = assembleHerdState({
    sessions: [],
    epics: [epic()],
    overnightDelta: { mergedPrs: [], archivedSessions: [] },
    generatedFor: "2026-06-15",
    now: NOW,
  });
  expect(out.epics.at(0)?.pausedReason).toBeUndefined();
});

test("buildRundownPrompt: paused epic rendered with PAUSED tag and reason text", () => {
  const out = assembleHerdState({
    sessions: [],
    epics: [epic({ pausedReason: "cap", landingPr: 55 })],
    overnightDelta: { mergedPrs: [], archivedSessions: [] },
    generatedFor: "2026-06-15",
    now: NOW,
  });
  const prompt = buildRundownPrompt(out);
  expect(prompt).toContain("EPICS AWAITING LANDING");
  expect(prompt).toContain("PAUSED");
  expect(prompt).toContain("rebase cap exhausted");
  expect(prompt).toContain("landing PR #55");
  // not echoed in the JSON dump
  const dump = prompt.slice(prompt.indexOf("Herd state (already significance-ranked)"));
  expect(dump).not.toContain('"epics"');
});

test("buildRundownPrompt: driver-paused epic renders driver reason", () => {
  const out = assembleHerdState({
    sessions: [],
    epics: [epic({ pausedReason: "driver" })],
    overnightDelta: { mergedPrs: [], archivedSessions: [] },
    generatedFor: "2026-06-15",
    now: NOW,
  });
  const prompt = buildRundownPrompt(out);
  expect(prompt).toContain("merge driver unavailable");
});

test("buildRundownPrompt: conflict-paused epic renders conflict reason", () => {
  const out = assembleHerdState({
    sessions: [],
    epics: [epic({ pausedReason: "conflict" })],
    overnightDelta: { mergedPrs: [], archivedSessions: [] },
    generatedFor: "2026-06-15",
    now: NOW,
  });
  const prompt = buildRundownPrompt(out);
  expect(prompt).toContain("genuine merge conflict");
});

test("buildRundownPrompt: mixed paused + ready epics both rendered in dedicated block", () => {
  const out = assembleHerdState({
    sessions: [],
    epics: [
      epic({ parent: 7, pausedReason: "cap" }),
      epic({ parent: 8, stranded: true }), // ready, no pausedReason
    ],
    overnightDelta: { mergedPrs: [], archivedSessions: [] },
    generatedFor: "2026-06-15",
    now: NOW,
  });
  const prompt = buildRundownPrompt(out);
  expect(prompt).toContain("PAUSED");
  expect(prompt).toContain("rebase cap exhausted");
  expect(prompt).toContain("STRANDED");
  // both epics mentioned
  expect(prompt).toContain("#7");
  expect(prompt).toContain("#8");
});

// ─── operator-language injection (issue #1625) ──────────────────────────────

// fenceUntrusted() mints a random per-call nonce, so two independent buildRundownPrompt calls
// never come out byte-identical purely because of it. Normalize it out before comparing.
const normalizeUntrustedNonce = (s: string): string =>
  s.replace(/⟦(\/?)UNTRUSTED:([\w ]+):[0-9a-f]+⟧/g, "⟦$1UNTRUSTED:$2:NONCE⟧");

// A herd with a halted-error session so an assembled `hold` is present — this exercises the
// renderHold(hold, operatorLanguage) branch (else the byte-identity test would pass vacuously).
const holdAssembled = () =>
  assembleHerdState({
    sessions: [session({ haltReason: "error" })],
    overnightDelta: { mergedPrs: [], archivedSessions: [] },
    generatedFor: "2026-07-11",
    now: NOW,
  });

test("en is byte-identical: buildRundownPrompt with/without explicit operatorLanguage:'en'", () => {
  const out = holdAssembled();
  const withoutLang = normalizeUntrustedNonce(buildRundownPrompt(out));
  const withEnLang = normalizeUntrustedNonce(buildRundownPrompt(out, "en"));
  expect(withEnLang).toBe(withoutLang);
  expect(withoutLang).not.toContain("German");
  expect(withEnLang).not.toContain("German");
  // Proves the fixture carries a hold so the renderHold branch is actually reached (non-vacuous).
  expect(withoutLang).toContain("Halted on an error");
});

test("de: buildRundownPrompt appends the directive and renders the hold `why` line in German", () => {
  const p = buildRundownPrompt(holdAssembled(), "de");
  expect(p).toContain("German");
  // operator-facing prose fields named
  expect(p).toContain("overnight");
  expect(p).toContain("train");
  expect(p).toContain("`label`");
  // machine-read fields called out as verbatim
  expect(p).toContain("`sessionId`");
  expect(p).toContain("`pr`");
  // the threaded renderHold(hold, "de") produced the German copy in the herd-state dump
  expect(p).toContain("Auf einem Fehler gestoppt");
  expect(p).not.toContain("Halted on an error");
});

// ── pr-conflict: Tier 1, ahead of ci-red, busy-qualified ────────────────────────

test("pr-conflict is the PRIMARY hold line for a red + dirty PR (ahead of ci-red)", () => {
  const s = session({ status: "idle" });
  const caches = {
    git: { state: "open", checks: "failure", mergeStateStatus: "dirty", number: 7 },
  } as any;
  const { tier, signals } = classifyAttention(s, caches, 0);
  expect(tier).toBe(1);
  expect(signals).toContain("pr-conflict");
  // explainHold takes the first non-"in-flight" signal — pr-conflict must precede ci-red,
  // or its line could never render for the case it exists to describe.
  expect(signals.indexOf("pr-conflict")).toBeLessThan(signals.indexOf("ci-red"));
  expect(explainHold(s, caches, 0)?.code).toBe("pr-conflict");
});

test("pr-conflict does NOT fire for a busy session actively resolving the conflict", () => {
  const s = session({ status: "running" });
  const caches = { git: { state: "open", mergeStateStatus: "dirty", number: 7 } } as any;
  expect(classifyAttention(s, caches, 0).signals).not.toContain("pr-conflict");
});

test("pr-conflict DOES fire for a busy-but-STALLED session (the hung-session backstop)", () => {
  // The busy gate means such a session never reaches rebaseCap, so the signal is its only
  // backstop.
  const s = session({ status: "running" });
  const caches = {
    git: { state: "open", mergeStateStatus: "dirty", number: 7 },
    stalled: true,
  } as any;
  expect(classifyAttention(s, caches, 0).signals).toContain("pr-conflict");
});

test("live hold path: a hung conflicting session surfaces via blocked-decision, not pr-conflict", () => {
  // HoldReasonService supplies no `stalled` (its caches are git/review/gate/recap/train/block —
  // the stall probe is fs reads, barred by the zero-I/O rule), so the qualifier degrades to
  // !busy. The poller's stall block arrives as `block` instead and lights blocked-decision,
  // which is Tier 1 and ordered ABOVE pr-conflict — so it is the primary line either way.
  const s = session({ status: "running" });
  const caches = {
    git: { state: "open", mergeStateStatus: "dirty", number: 7 },
    block: { shape: "stall", options: [], tail: [] },
  } as any;
  const { tier, signals } = classifyAttention(s, caches, 0);
  expect(tier).toBe(1);
  expect(signals).not.toContain("pr-conflict");
  expect(signals).toContain("blocked-decision");
  // …and a stall-shaped block renders the more specific `blocked-stall` hold copy.
  expect(explainHold(s, caches, 0)?.code).toBe("blocked-stall");
});

test("blocked-decision outranks pr-conflict even when both fire", () => {
  const s = session({ status: "running" });
  const caches = {
    git: { state: "open", mergeStateStatus: "dirty", number: 7 },
    block: { shape: "stall", options: [], tail: [] },
    stalled: true,
  } as any;
  const { signals } = classifyAttention(s, caches, 0);
  expect(signals.indexOf("blocked-decision")).toBeLessThan(signals.indexOf("pr-conflict"));
});

test("pr-conflict is omitted for a merged/closed PR", () => {
  const s = session({ status: "idle" });
  for (const state of ["merged", "closed"]) {
    const caches = { git: { state, mergeStateStatus: "dirty", number: 7 } } as any;
    expect(classifyAttention(s, caches, 0).signals).not.toContain("pr-conflict");
  }
});

test("a Gitea DRAFT (mergeable:false, no mergeStateStatus) does not fire pr-conflict", () => {
  const s = session({ status: "idle" });
  const caches = { git: { state: "open", mergeable: false, isDraft: true, number: 7 } } as any;
  expect(classifyAttention(s, caches, 0).signals).not.toContain("pr-conflict");
});

test("a red Gitea PR (mergeable:false, no mergeStateStatus) keeps the accurate ci-red line", () => {
  // Gitea folds branch-protection into `mergeable`, so a red-but-perfectly-mergeable PR reports
  // mergeable:false. Because pr-conflict OUTRANKS ci-red, firing it here would replace an
  // accurate "CI is failing" hold with a false "has merge conflicts — CI can't run until it's
  // rebased". The rule gates on isDefiniteConflict precisely to prevent that.
  const s = session({ status: "idle" });
  const caches = {
    git: { state: "open", checks: "failure", mergeable: false, number: 7 },
  } as any;
  const { signals } = classifyAttention(s, caches, 0);
  expect(signals).not.toContain("pr-conflict");
  expect(signals).toContain("ci-red");
  expect(explainHold(s, caches, 0)?.code).toBe("ci-red");
});

test("mergeable:false + a settled non-dirty mergeStateStatus is definite → pr-conflict wins", () => {
  // On GitHub `mergeable:false` is unambiguous (mapMergeable: false ⟺ CONFLICTING), so the
  // conflict line is the accurate one even without `dirty`.
  const s = session({ status: "idle" });
  const caches = {
    git: {
      state: "open",
      checks: "failure",
      mergeable: false,
      mergeStateStatus: "blocked",
      number: 7,
    },
  } as any;
  expect(explainHold(s, caches, 0)?.code).toBe("pr-conflict");
});

test("KNOWN GAP: a conflicting Gitea PR gets no pr-conflict signal (chip only)", () => {
  // Deliberate and documented at the rule. Gitea never sets mergeStateStatus, so a genuine
  // conflict is indistinguishable from branch protection — and this rule outranks ci-red while
  // emitting a specific actionable claim. Asserted so the gap is a decision, not a surprise.
  const s = session({ status: "idle" });
  const caches = { git: { state: "open", mergeable: false, number: 7 } } as any;
  expect(classifyAttention(s, caches, 0).signals).not.toContain("pr-conflict");
});

test("red+dirty surfaces pr-conflict, so the row-level Retry CI CTA is intentionally dropped", () => {
  // hold-row.ts gates that CTA on serverHold.code === "ci-red", and hold-service derives
  // serverHold from explainHold. Asserting the code here pins the knock-on: a dirty PR's
  // pull_request workflows can't run at all, so offering a re-run would be futile.
  const s = session({ status: "idle" });
  const caches = {
    git: { state: "open", checks: "failure", mergeStateStatus: "dirty", number: 7 },
  } as any;
  expect(explainHold(s, caches, 0)?.code).toBe("pr-conflict");
});
