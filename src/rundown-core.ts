/**
 * Pure helpers for the Herd Rundown feature — no I/O, no DB, no spawn.
 * Mirrors recap-core.ts (classify / assemble / prompt / parse + clamp).
 *
 * The Rundown synthesizes a cross-session attention digest answering "what needs a
 * human right now?" across the whole live agent herd, keyed by calendar day.
 */
import type {
  Session,
  ReviewVerdict,
  PlanGate,
  Recap,
  RundownItem,
  RundownEpicItem,
  RundownVerdict,
  HoldReason,
} from "./types";
import type { GitState } from "./forge/types";
import type { BlockReason } from "./blocked";
import { blockReasonToHoldCode, renderHold } from "./hold";
import { verdictStale } from "./verdict-freshness";
import { isDefiniteConflict } from "./pr-conflict";
import { fenceUntrusted } from "./untrusted";
import type { OperatorLanguage } from "./operator-language";
import { addressStallStatus } from "./review-status";

export const RUNDOWN_VERDICT_FILE = ".shepherd-rundown.json";

// Clamp bounds for the parsed verdict (also encoded in the prompt's length guidance).
const RUNDOWN_OVERNIGHT_MAX = 280;
const RUNDOWN_TRAIN_MAX = 200;
export const RUNDOWN_LABEL_MAX = 140;
export const RUNDOWN_DECISIONS_CAP = 6;
const RUNDOWN_CIREWORK_CAP = 6;
export const RUNDOWN_FOCUSNEXT_CAP = 3;
export const RUNDOWN_DEFAULT_TOPN = 40;
// Bound on the deterministic "land this epic" Tier-1 items (#1045). Completed epics are few per
// repo; this is a safety ceiling, not an expected limit.
export const RUNDOWN_EPICS_CAP = 12;

// DRIFT: keep in sync with ui/src/lib/components/merge-train.ts (MERGE_MARK_BACKSTOP_MS).
// Re-implemented server-side so the rundown can classify merging sessions without
// importing UI code; a parity test in rundown-core.test.ts locks the two literals together.
export const MERGE_MARK_BACKSTOP_MS = 24 * 60 * 60_000;

/** True when a session is in a currently-running merge train: marked and still within the
 *  safety backstop. Mirrors isMerging() in ui/src/lib/components/merge-train.ts. */
export function isMerging(s: Pick<Session, "mergingSince">, now: number = Date.now()): boolean {
  return s.mergingSince !== null && now - s.mergingSince < MERGE_MARK_BACKSTOP_MS;
}

// ── attention tiers + signal classification ──────────────────────────────────
export type AttentionTier = 1 | 2 | 3;

export type SignalCode =
  | "halted-error"
  | "halted-usage"
  | "blocked-decision"
  | "plan-rework"
  | "plan-question"
  | "critic-rework"
  | "ci-red"
  | "pr-conflict"
  | "manual-steps"
  | "awaiting-merge"
  | "stalled"
  | "recap-attention"
  | "train-error"
  | "ready-merge"
  | "in-flight"
  | "merging";

/** Most-urgent (lowest) tier each signal belongs to. A session's tier is the min over
 *  its signals. Tier 1 = CRITICAL (blocked on operator), 2 = HIGH (needs a look soon),
 *  3 = NORMAL (routine in-flight / queued). */
const SIGNAL_TIER: Record<SignalCode, AttentionTier> = {
  "halted-error": 1,
  "blocked-decision": 1,
  "plan-rework": 1,
  "plan-question": 1,
  "critic-rework": 1,
  "ci-red": 1,
  "pr-conflict": 1,
  "manual-steps": 1,
  "halted-usage": 2,
  "awaiting-merge": 2,
  stalled: 2,
  "recap-attention": 2,
  "train-error": 2,
  "ready-merge": 3,
  "in-flight": 3,
  merging: 3,
};

export interface ClassifyCaches {
  git?: GitState;
  review?: ReviewVerdict;
  gate?: PlanGate;
  recap?: Recap;
  /** Merge-train state for this session, when known (e.g. an errored train run). */
  train?: { error?: boolean };
  /** Precomputed stall flag — kept as input so classifyAttention stays pure (stall
   *  detection reads terminal buffers / files, which belongs to the caller). */
  stalled?: boolean;
  /** Live BlockReason for this session (WS-only; supplied by the live HoldReasonService).
   *  Makes blocked-decision fire for a running-but-stalled session whose status hasn't
   *  flipped to "blocked". Absent in the rundown (no block snapshot). */
  block?: BlockReason | null;
  /** Epoch ms the usage window resets — used ONLY by explainHold for the halted-usage
   *  param; classifyAttention ignores it. */
  resetAt?: number;
}

/** True when `gate` has ≥1 question-form question whose `${blockId} ${questionId}` key is not
 *  in `answeredQuestionKeys` — i.e. an operator answer is still pending (#1332). Pure and
 *  self-contained (no plan-gate import — keeps this module I/O-free). The attention rule ANDs
 *  this with `planPhase === "planning"`. Mirrored in the UI's tab-signal.svelte.ts and
 *  drift-locked by test/fixtures/plan-question-parity.json. */
export function planQuestionsUnanswered(gate: PlanGate | null | undefined): boolean {
  if (!gate?.blocks?.length) return false;
  const answered = new Set(gate.answeredQuestionKeys ?? []);
  for (const b of gate.blocks) {
    if (b.type !== "question-form") continue;
    for (const q of b.questions) {
      if (!answered.has(`${b.id} ${q.id}`)) return true;
    }
  }
  return false;
}

/** A session's plan gate surfaces as active plan-rework only when it is the OPERATOR's turn:
 *  changes were requested, the operator hasn't dismissed/taken over, and the session is NOT
 *  running. A running session is the AGENT's turn — it is actively revising the plan (the row
 *  reads "Agent is revising the plan"), so it must NOT rank as a Tier-1 "blocked on operator"
 *  decision; it falls through to the routine `in-flight` signal (Tier-3) instead (#1629). A parked
 *  (idle/done) rework still counts — awaiting re-review, or an idle stalled/at-cap streak that
 *  co-fires blocked-decision via the quota block. Shared by the attention rule + the planRound copy
 *  so the two never drift. */
function planReworkActive(s: Session, gate: PlanGate | undefined): boolean {
  return (
    s.planPhase === "planning" &&
    gate?.decision === "changes_requested" &&
    !gate.dismissed &&
    s.status !== "running"
  );
}

/** Critic-side twin of planReworkActive (no planPhase gate — critic rework runs post-PR).
 *  A verdict for an OLDER head (rework pushed, PR open at a newer head) is stale — the agent
 *  already delivered, a re-review is pending — so it is not active rework (matches troubleHold). */
function criticReworkActive(
  s: Session,
  review: ReviewVerdict | undefined,
  git: GitState | undefined,
  now: number,
): boolean {
  return (
    review?.decision === "changes_requested" &&
    !review.dismissed &&
    !verdictStale(review.headSha, git) &&
    !(s.status === "running" && addressStallStatus(review, now) === "stalled")
  );
}

/** Ordered (signal, predicate) rules. classifyAttention pushes each signal whose predicate
 *  holds, in this exact order — Tier-1 codes first, then Tier-2, then Tier-3 — so the emitted
 *  `signals` array order is stable. Splitting the predicates out of classifyAttention keeps
 *  that function a simple loop; the tiering comment lives with the SIGNAL_TIER map above. */
const ATTENTION_RULES: Array<{
  signal: SignalCode;
  when: (s: Session, c: ClassifyCaches, now: number) => boolean;
}> = [
  // Tier 1: CRITICAL — forward progress blocked on the operator.
  { signal: "halted-error", when: (s) => s.haltReason === "error" },
  {
    signal: "blocked-decision",
    when: (s, c) =>
      s.status === "blocked" ||
      Boolean(s.autopilotPaused && s.autopilotQuestion) ||
      Boolean(c.block),
  },
  { signal: "plan-rework", when: (s, c) => planReworkActive(s, c.gate) },
  { signal: "critic-rework", when: (s, c, now) => criticReworkActive(s, c.review, c.git, now) },
  // pr-conflict BEFORE ci-red: explainHold takes the first non-"in-flight" signal, so a
  // later-listed rule could never render its line for a red+dirty PR — the flagship case. A
  // conflict is also the actionable root cause there ("rebase, CI can't run" beats "CI is
  // failing"): the red run was against a stale base and the rebase re-runs it.
  //
  // isDefiniteConflict, NOT the broad isConflicting: this rule OUTRANKS ci-red, so it may only
  // fire where the conflict is certain. Gitea never sets mergeStateStatus and folds
  // branch-protection into `mergeable`, so a red-but-perfectly-mergeable Gitea PR reports
  // `mergeable: false` — the broad predicate would replace an accurate "CI is failing" line with
  // a false "has merge conflicts — CI can't run until it's rebased". Where the signal is
  // ambiguous, the accurate one wins.
  //
  // KNOCK-ON, intended: because explainHold surfaces this instead of ci-red, a red+dirty session
  // also loses its row-level "Retry CI" CTA (hold-row.ts keys that on serverHold.code ===
  // "ci-red"). That is correct — a dirty PR's pull_request workflows cannot run at all, so
  // re-running them is futile; the actionable step is the rebase this line names. Called out in
  // the PR description because it is user-visible.
  //
  // KNOWN GAP, deliberate: isDefiniteConflict is structurally always false on Gitea and
  // LocalForge (neither sets mergeStateStatus), so a genuinely conflicting PR there gets the
  // PRs-tab chip but NO rundown/digest signal. Do not "fix" this by widening the predicate: on
  // Gitea `mergeable: false` cannot be told apart from branch protection, and this hold line
  // makes a specific actionable claim ("rebase it") that would then be wrong. A missing signal
  // is recoverable — the chip still marks the PR; a false instruction sends the operator to
  // rebase a PR that has no conflict. Closing it properly needs a per-forge conflict signal
  // Gitea does not currently expose.
  //
  // (!busy || stalled): a session actively RESOLVING its conflict is protected by the merge
  // train's busy gate and would otherwise show a Tier-1 line for the whole duration. But a HUNG
  // session is running/blocked too, and is the one case where this signal is the only backstop
  // (the busy gate means it never reaches rebaseCap), so `stalled` distinguishes them.
  {
    signal: "pr-conflict",
    when: (s, c) => {
      if (c.git?.state !== "open" || !isDefiniteConflict(c.git)) return false;
      const busy = s.status === "running" || s.status === "blocked";
      return !busy || Boolean(c.stalled);
    },
  },
  { signal: "ci-red", when: (_s, c) => c.git?.checks === "failure" },
  // manual-steps: a PR declares un-acked, non-POST-MERGE manual operator steps that gate its
  // auto-merge (#1060). Last in the Tier-1 block so a genuinely-more-urgent co-signal stays the
  // PRIMARY hold line while the session still classifies Tier-1. Requires an OPEN PR so it can't
  // fire pre-PR (no steps yet) or post-merge (a PR a human merged manually before archive), where
  // the gate is moot. POST-MERGE-only steps never qualify (they only inform + carry forward).
  {
    signal: "manual-steps",
    when: (s, c) =>
      s.manualStepsAckedAt == null &&
      c.git?.state === "open" &&
      s.manualSteps.some((st) => !st.postMerge),
  },
  // plan-question: an AUTO plan gate carries question-form questions the operator hasn't
  // answered yet, still in the planning phase (#1332 / #803). LAST in the Tier-1 block (like
  // manual-steps) so a co-occurring, genuinely-more-urgent signal — notably plan-rework, whose
  // round/cap copy is more actionable — stays the PRIMARY hold line; plan-question becomes
  // primary only when it is the sole Tier-1 signal. Guarded on planning so it never leaks into
  // execution (an approved AUTO plan auto-releases and the questions go moot).
  {
    signal: "plan-question",
    when: (s, c) => s.planPhase === "planning" && planQuestionsUnanswered(c.gate),
  },
  // Tier 2: HIGH — needs a look soon, not yet a hard stop.
  { signal: "halted-usage", when: (s) => s.haltReason === "usage_limit" },
  // awaiting-merge: operator's turn — the server has handed the PR off to a merger.
  { signal: "awaiting-merge", when: (_s, c) => c.git?.handoff === "merger" },
  { signal: "stalled", when: (_s, c) => Boolean(c.stalled) },
  { signal: "recap-attention", when: (_s, c) => c.recap?.verdict === "needs_attention" },
  { signal: "train-error", when: (_s, c) => Boolean(c.train?.error) },
  // Tier 3: NORMAL — routine in-flight / queued work.
  // ready-merge: PR is ready but not yet handed to a merger (Tier 2 takes over once it is).
  {
    signal: "ready-merge",
    when: (s, c) => s.readyToMerge && c.git?.handoff !== "merger",
  },
  {
    signal: "in-flight",
    when: (s) => s.status === "running" || s.status === "idle",
  },
  { signal: "merging", when: (s, _c, now) => isMerging(s, now) },
];

/** Classify a single session's attention demand into a tier + its raw signal codes.
 *  Pure: every input is already-derived state, no I/O. A session may carry multiple
 *  signals; its tier is the most urgent (lowest) of them. Returns `tier: null` when the
 *  session bears no attention signal at all (filtered out of fingerprints/assembly). */
export function classifyAttention(
  session: Session,
  caches: ClassifyCaches,
  now: number = Date.now(),
): { tier: AttentionTier | null; signals: SignalCode[] } {
  const signals: SignalCode[] = [];
  for (const rule of ATTENTION_RULES) {
    if (rule.when(session, caches, now)) signals.push(rule.signal);
  }

  if (signals.length === 0) return { tier: null, signals: [] };
  const tier = signals.reduce<AttentionTier>(
    (acc, s) => (SIGNAL_TIER[s] < acc ? SIGNAL_TIER[s] : acc),
    3,
  );
  return { tier, signals };
}

// ── explainHold ───────────────────────────────────────────────────────────────

const SIGNAL_TO_HOLD: Record<
  Exclude<SignalCode, "in-flight">,
  (session: Session, caches: ClassifyCaches) => HoldReason
> = {
  "blocked-decision": (session, caches) => {
    if (session.autopilotPaused && session.autopilotQuestion) {
      return { code: "autopilot-paused", params: { question: session.autopilotQuestion } };
    }
    if (caches.block) {
      return { code: blockReasonToHoldCode(caches.block) };
    }
    return { code: "blocked-generic" };
  },
  "plan-rework": (_session, caches) => {
    const params: Record<string, number> = {};
    if (caches.gate?.round !== undefined) params.round = caches.gate.round;
    if (caches.gate?.cap !== undefined) params.cap = caches.gate.cap;
    return Object.keys(params).length > 0
      ? { code: "plan-rework", params }
      : { code: "plan-rework" };
  },
  "plan-question": () => ({ code: "plan-question" }),
  "critic-rework": (_session, caches) => {
    const count = caches.review?.findings?.length;
    return count !== undefined
      ? { code: "critic-rework", params: { findings: count } }
      : { code: "critic-rework" };
  },
  "ci-red": (_session, caches) => {
    const pr = caches.git?.number;
    return pr !== undefined ? { code: "ci-red", params: { pr } } : { code: "ci-red" };
  },
  "pr-conflict": (_session, caches) => {
    const pr = caches.git?.number;
    return pr !== undefined ? { code: "pr-conflict", params: { pr } } : { code: "pr-conflict" };
  },
  "awaiting-merge": (_session, caches) => {
    const pr = caches.git?.number;
    return pr !== undefined
      ? { code: "awaiting-merge", params: { pr } }
      : { code: "awaiting-merge" };
  },
  "train-error": (_session, caches) => {
    const pr = caches.git?.number;
    return pr !== undefined ? { code: "train-error", params: { pr } } : { code: "train-error" };
  },
  "ready-merge": (_session, caches) => {
    const pr = caches.git?.number;
    return pr !== undefined ? { code: "ready-merge", params: { pr } } : { code: "ready-merge" };
  },
  "manual-steps": (session) => {
    const steps = session.manualSteps.filter((st) => !st.postMerge).length;
    return { code: "manual-steps", params: { steps } };
  },
  stalled: () => ({ code: "stalled" }),
  "recap-attention": () => ({ code: "recap-attention" }),
  "halted-error": () => ({ code: "halted-error" }),
  "halted-usage": (_session, caches) =>
    caches.resetAt !== undefined
      ? { code: "halted-usage", params: { resetAt: caches.resetAt } }
      : { code: "halted-usage" },
  merging: (session) => {
    if (session.autoMergeRebaseHead != null) {
      return {
        code: "merge-rebasing",
        params: { rebaseCount: session.autoMergeRebaseCount },
      };
    }
    const pr = session.mergingPrNumber ?? undefined;
    return pr !== undefined ? { code: "merging", params: { pr } } : { code: "merging" };
  },
};

/** Map a primary signal to a HoldReason. Internal to explainHold.
 *  `primary` is guaranteed never to be "in-flight" — the caller filters it out. */
function renderSignalToHold(
  primary: Exclude<SignalCode, "in-flight">,
  session: Session,
  caches: ClassifyCaches,
): HoldReason {
  return SIGNAL_TO_HOLD[primary](session, caches);
}

/** Derive the hold reason for a session from its primary attention signal. Returns null
 *  when the session is routine (in-flight / no signals). Single source of truth —
 *  delegates to classifyAttention rather than re-deciding. */
export function explainHold(
  session: Session,
  caches: ClassifyCaches,
  now?: number,
): HoldReason | null {
  const { signals } = classifyAttention(session, caches, now);
  // Skip "in-flight" — it fires for any running/idle session and should never shadow a
  // co-occurring signal (e.g. a merging session that is also running/idle).
  const primary = signals.find((s) => s !== "in-flight");
  if (!primary) return null; // no signals, or only in-flight (routine) → no hold
  return renderSignalToHold(primary, session, caches);
}

/** Map sessionId → sorted signal codes, for the attention-bearing sessions only. The
 *  digest stores this so a later pass can measure how far the herd has drifted. */
export function attentionFingerprint(
  classified: Array<{ sessionId: string; signals: SignalCode[] }>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const c of classified) {
    if (c.signals.length === 0) continue;
    out[c.sessionId] = [...c.signals].sort();
  }
  return out;
}

/** Count sessionIds whose sorted signal set differs between two fingerprints — a signal
 *  added, removed, or changed each counts as one. Identical fingerprints → 0. */
export function fingerprintDiffCount(
  prev: Record<string, string[]>,
  current: Record<string, string[]>,
): number {
  const ids = new Set([...Object.keys(prev), ...Object.keys(current)]);
  let n = 0;
  for (const id of ids) {
    const a = prev[id];
    const b = current[id];
    if (!a || !b || a.length !== b.length || a.some((s, i) => s !== b[i])) n++;
  }
  return n;
}

// ── assembled herd state (data-only, fed to the prompt) ──────────────────────
export interface AssembledSession {
  desig: string;
  sessionId: string;
  repo: string;
  tier: AttentionTier;
  signals: SignalCode[];
  ageMs: number;
  /** Backlog-priority rank of this session's repo (lower = higher priority; 0 = top). A large
   *  sentinel when the repo has no backlog rank, so it sorts last within its tier. */
  backlogRank: number;
  prNumber?: number;
  prUrl?: string;
  findings?: string[];
  planRound?: number;
  hold?: HoldReason;
}

export interface AssembledHerdState {
  generatedFor: string;
  overnightDelta: { mergedPrs: number[]; archivedSessions: { id: string; desig: string }[] };
  sessions: AssembledSession[];
  /** Deterministic Tier-1 "land this epic" items (#1045) — landing-ready completed epics with no
   *  live session. NOT classified/ranked like sessions; injected by the server, never dropped. */
  epics: RundownEpicItem[];
  /** Count of Tier-2 sessions elided by the topN budget (0 when none dropped). Tier-1 is
   *  never dropped, so a positive count here means a HIGH-attention session is hidden. */
  truncatedTier2: number;
  /** Count of Tier-3 sessions elided by the topN budget (0 when none dropped). */
  truncatedTier3: number;
}

export interface AssembleInput {
  sessions: Session[];
  git?: Record<string, GitState>;
  reviews?: Record<string, ReviewVerdict>;
  gates?: Record<string, PlanGate>;
  recaps?: Record<string, Recap>;
  stalled?: Set<string>;
  /** Merge-train state by sessionId (e.g. errored train runs). */
  trains?: Record<string, { error?: boolean }>;
  overnightDelta: { mergedPrs: number[]; archivedSessions: { id: string; desig: string }[] };
  generatedFor: string;
  /** Landing-ready completed epics to surface as Tier-1 "land this epic" items (#1045). Optional —
   *  absent ⇒ none. Sliced to RUNDOWN_EPICS_CAP. */
  epics?: RundownEpicItem[];
  now?: number;
  topN?: number;
  /** Backlog-priority rank per repoPath (lower = higher priority; 0 = top-priority repo). A
   *  session whose repoPath is absent here is treated as lowest priority. From /api/backlog's
   *  open-issue ranking; weights focusNext within a tier. */
  backlogRank?: Record<string, number>;
}

/** Sentinel rank for a repo with no backlog priority — sorts after any ranked repo within a tier. */
const NO_BACKLOG_RANK = Number.MAX_SAFE_INTEGER;

// Order WITHIN equal tier: higher-priority repo (lower backlogRank) first, then oldest first.
// Tier is always primary, so a higher-priority repo never jumps ahead of a more-urgent tier —
// bottlenecks (Tier 1) still outrank routine work regardless of backlog priority.
const byTierRankAge = (a: AssembledSession, b: AssembledSession) =>
  a.tier - b.tier || a.backlogRank - b.backlogRank || b.ageMs - a.ageMs;

/** Classify one live session and map it to an AssembledSession, or null when it bears no
 *  attention signal (tier null) or is archived. Pulls this session's caches out of the
 *  per-field maps in `input`. */
function toAssembledSession(
  s: Session,
  input: AssembleInput,
  now: number,
): AssembledSession | null {
  if (s.status === "archived") return null;
  const git = input.git?.[s.id];
  const review = input.reviews?.[s.id];
  const gate = input.gates?.[s.id];
  const recap = input.recaps?.[s.id];
  const caches: ClassifyCaches = {
    git,
    review,
    gate,
    recap,
    train: input.trains?.[s.id],
    stalled: input.stalled?.has(s.id),
  };
  const { tier, signals } = classifyAttention(s, caches, now);
  if (tier === null) return null;
  const item: AssembledSession = {
    desig: s.desig,
    sessionId: s.id,
    repo: s.repoPath,
    tier,
    signals,
    ageMs: Math.max(0, now - s.createdAt),
    backlogRank: input.backlogRank?.[s.repoPath] ?? NO_BACKLOG_RANK,
  };
  if (git?.number != null) item.prNumber = git.number;
  if (git?.url) item.prUrl = git.url;
  if (review?.findings?.length) item.findings = review.findings;
  // Same predicate as the plan-rework signal so the round copy tracks it.
  if (gate && planReworkActive(s, gate)) item.planRound = gate.round;
  const hold = explainHold(s, caches, now);
  if (hold !== null) item.hold = hold;
  return item;
}

/** Trim a tier/rank/age-sorted list to `topN` with a HARD GUARANTEE that every Tier-1 session
 *  survives; remaining budget is filled with Tier-2 then Tier-3 in order. Returns the kept set
 *  (re-sorted uniformly) plus the count of Tier-2/Tier-3 dropped. */
function applyBudget(
  ranked: AssembledSession[],
  topN: number,
): {
  kept: AssembledSession[];
  truncatedTier2: number;
  truncatedTier3: number;
} {
  const tier1 = ranked.filter((s) => s.tier === 1);
  const rest = ranked.filter((s) => s.tier !== 1);
  const budget = Math.max(0, topN - tier1.length);
  const kept = [...tier1, ...rest.slice(0, budget)];
  const dropped = rest.slice(budget);
  // Re-sort the kept set so output is uniformly tier/backlog-rank/age ordered.
  kept.sort(byTierRankAge);
  return {
    kept,
    truncatedTier2: dropped.filter((s) => s.tier === 2).length,
    truncatedTier3: dropped.filter((s) => s.tier === 3).length,
  };
}

/** Pure builder: classify every session, order by tier then age (older first within a
 *  tier), and trim to `topN` — but with a HARD GUARANTEE that every Tier-1 session is
 *  included unconditionally; remaining budget is filled with Tier-2 then Tier-3 by
 *  tier/age. Any Tier-2/Tier-3 dropped is reported via `truncatedTier2`/`truncatedTier3`
 *  (Tier-1 is never dropped). Data-only (no prose). */
export function assembleHerdState(input: AssembleInput): AssembledHerdState {
  const now = input.now ?? Date.now();
  const topN = input.topN ?? RUNDOWN_DEFAULT_TOPN;

  const ranked: AssembledSession[] = [];
  for (const s of input.sessions) {
    const item = toAssembledSession(s, input, now);
    if (item) ranked.push(item);
  }
  ranked.sort(byTierRankAge);

  const { kept, truncatedTier2, truncatedTier3 } = applyBudget(ranked, topN);

  return {
    generatedFor: input.generatedFor,
    overnightDelta: input.overnightDelta,
    sessions: kept,
    epics: (input.epics ?? []).slice(0, RUNDOWN_EPICS_CAP),
    truncatedTier2,
    truncatedTier3,
  };
}

// ── prompt ───────────────────────────────────────────────────────────────────
/** The instruction prompt for the rundown spawn. Encodes the triage contract and tells
 *  the agent to Write `.shepherd-rundown.json` as its final action, then stop. */
export function buildRundownPrompt(
  assembled: AssembledHerdState,
  operatorLanguage: OperatorLanguage = "en",
): string {
  const lines = [
    "You are triaging an autonomous-agent fleet for a SINGLE human operator. Your job is to",
    'answer one question: "what needs a human right now?" — across the whole live herd.',
    "Do NOT modify, build, commit, or run anything — this is read-only synthesis.",
    "",
    'A session "needs a human right now" when EITHER:',
    "  - forward progress is blocked on an operator action or decision, OR",
    "  - an autonomous loop has stalled or failed in a way it will NOT self-recover from",
    "    (CI red and unaddressed, REWORK over its retry budget, a stalled session, an",
    "    unanswered autopilot question).",
    "It does NOT include routine in-flight work, nor anything the merge-train or the critic",
    "handle automatically — do not surface those as if they need the operator.",
    "",
    "The `sessions` array below is ALREADY significance-ranked: Tier-1 (CRITICAL, blocked on",
    "the operator) come first, then Tier-2 (HIGH), then Tier-3 (NORMAL). Respect that order —",
    "lead with the most urgent.",
    "Each session carries a `backlogRank` (lower = higher-priority repo per the backlog;",
    "a large value means the repo has no ranking). When choosing `focusNext`, prefer items from",
    "higher-priority repos (lower backlogRank) — but bottlenecks ALWAYS outrank routine work:",
    "never let backlog priority promote a lower-tier item above a genuine Tier-1 blocker.",
  ];

  if (assembled.truncatedTier2 > 0 || assembled.truncatedTier3 > 0) {
    const parts: string[] = [];
    if (assembled.truncatedTier2 > 0) parts.push(`${assembled.truncatedTier2} Tier-2 (HIGH)`);
    if (assembled.truncatedTier3 > 0) parts.push(`${assembled.truncatedTier3} Tier-3`);
    lines.push(
      `NOTE: ${parts.join(" and ")} lower-priority session(s) were elided to fit the budget —`,
      'do NOT claim "all clear" or that the herd is fully idle.',
    );
  }

  if (assembled.epics.length > 0) {
    const pausedEpics = assembled.epics.filter((e) => e.pausedReason != null);
    const readyEpics = assembled.epics.filter((e) => e.pausedReason == null && !e.ciFailing);
    const ciFailingEpics = assembled.epics.filter((e) => e.ciFailing === true);
    const pauseReasonLabel = (r: "cap" | "conflict" | "driver"): string => {
      if (r === "cap") return "rebase cap exhausted — needs manual rebase/push";
      if (r === "conflict") return "genuine merge conflict — needs operator resolution";
      return "merge driver unavailable on the server — needs environment fix";
    };
    lines.push(
      "",
      "EPICS AWAITING LANDING — integrated epics whose landing PR needs operator attention.",
      "They are ALREADY surfaced separately to the operator as Tier-1 items (a dedicated section),",
      'so you MUST NOT repeat them in decisions/focusNext. You MUST NOT claim "all clear" or that',
      "the herd is idle while any exist; you MAY mention them in `overnight` for context.",
      "For reference only (do NOT echo into the verdict):",
    );
    if (pausedEpics.length > 0) {
      lines.push("  Paused (auto-rebase blocked — operator action required):");
      lines.push(
        ...pausedEpics.flatMap((e) => {
          const reason = e.pausedReason;
          if (reason == null) return [];
          return [
            `    - ${e.repo} #${e.parent} "${e.title}"` +
              (e.landingPr != null ? ` (landing PR #${e.landingPr})` : "") +
              ` [PAUSED: ${pauseReasonLabel(reason)}]`,
          ];
        }),
      );
    }
    if (readyEpics.length > 0) {
      lines.push("  Ready to land:");
      lines.push(
        ...readyEpics.map(
          (e) =>
            `    - ${e.repo} #${e.parent} "${e.title}"` +
            (e.landingPr != null ? ` (landing PR #${e.landingPr})` : "") +
            (e.stranded ? " [STRANDED — unlanded well past threshold]" : ""),
        ),
      );
    }
    if (ciFailingEpics.length > 0) {
      lines.push("  CI failing (landing PR red — needs attention):");
      lines.push(
        ...ciFailingEpics.map(
          (e) =>
            `    - ${e.repo} #${e.parent} "${e.title}"` +
            (e.landingPr != null ? ` (landing PR #${e.landingPr})` : "") +
            " [CI FAILING — needs attention]",
        ),
      );
    }
  }

  // Strip `epics` from the herd-state dump below — they are rendered once in the dedicated block
  // above; leaving them in the dump would double-inject and tempt the agent to echo them into the
  // verdict (#1045).
  const { epics: _epics, ...assembledForDump } = assembled;
  void _epics;

  lines.push(
    'Each session may carry a "why" line — the system\'s reason it is held/blocked; use it to phrase the operator-facing items.',
    "",
    "Write your synthesis as JSON to the file `" +
      RUNDOWN_VERDICT_FILE +
      "` in your CWD with EXACTLY this shape:",
    "{",
    '  "overnight": "<what changed while the operator was away — merged PRs, archived sessions; \\"\\" if nothing>",',
    '  "decisions": [{ "label": "<a decision/answer the operator must give>", "sessionId"?: "<id>", "pr"?: <n> }, ...],',
    '  "ciRework": [{ "label": "<a CI-red or over-budget REWORK that is stuck>", "sessionId"?: "<id>", "pr"?: <n> }, ...],',
    '  "train": "<one-line state of the merge train / ready-to-merge queue; \\"\\" if nothing>",',
    '  "focusNext": [{ "label": "<what the operator should look at next once blockers clear>", "sessionId"?: "<id>", "pr"?: <n> }, ...]',
    "}",
    "Length guidance (hard caps are enforced on parse, so stay under them):",
    `  - overnight ≤ ~${RUNDOWN_OVERNIGHT_MAX} chars; train ≤ ~${RUNDOWN_TRAIN_MAX} chars; each label ≤ ~${RUNDOWN_LABEL_MAX} chars`,
    `  - decisions ≤ ${RUNDOWN_DECISIONS_CAP}, ciRework ≤ ${RUNDOWN_CIREWORK_CAP}, focusNext ≤ ${RUNDOWN_FOCUSNEXT_CAP}`,
    "Set sessionId/pr on an item whenever the herd state names them, so the UI can deep-link.",
    "Write the file as your final action, then stop.",
    "",
    "Herd state (already significance-ranked) — untrusted data (contains external issue/PR titles):",
    fenceUntrusted(
      "herd state",
      JSON.stringify(
        {
          ...assembledForDump,
          sessions: assembled.sessions.map((s) => {
            const { hold, ...rest } = s;
            if (hold) return { ...rest, why: renderHold(hold, operatorLanguage) };
            return rest;
          }),
        },
        null,
        2,
      ),
    ),
  );

  if (operatorLanguage === "de") {
    lines.push(
      "",
      "Write the operator-facing prose fields `overnight`, `train`, and every `label` in " +
        "`decisions[]`/`ciRework[]`/`focusNext[]` in German. Keep machine-read fields verbatim — " +
        "never translate `sessionId` (an opaque id) or `pr` (a number). Reproduce any quoted PR/" +
        "issue title from the herd state in its original language (GitHub text); write only the " +
        "surrounding synthesis in German.",
    );
  }

  return lines.join("\n");
}

// ── parse + clamp the spawn's verdict file ───────────────────────────────────
function clampItems(raw: unknown, cap: number): RundownItem[] {
  if (!Array.isArray(raw)) return [];
  const out: RundownItem[] = [];
  for (const x of raw) {
    if (out.length >= cap) break;
    if (!x || typeof x !== "object" || Array.isArray(x)) continue;
    const o = x as Record<string, unknown>;
    if (typeof o.label !== "string" || o.label.trim() === "") continue;
    const item: RundownItem = { label: o.label.slice(0, RUNDOWN_LABEL_MAX) };
    if (typeof o.sessionId === "string") item.sessionId = o.sessionId;
    if (typeof o.pr === "number" && Number.isFinite(o.pr)) item.pr = o.pr;
    out.push(item);
  }
  return out;
}

/** Parse + validate + clamp the raw `.shepherd-rundown.json` the spawn wrote. Fail-closed:
 *  returns null when the top level is unparseable or not an object. Otherwise coerces every
 *  field to bounds (arrays sliced to caps, labels/strings clamped, malformed items dropped,
 *  missing fields defaulted). Mirrors parseRecapVerdict's tolerance. */
export function parseRundownVerdict(raw: string): RundownVerdict | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const r = parsed as Record<string, unknown>;

  return {
    overnight: typeof r.overnight === "string" ? r.overnight.slice(0, RUNDOWN_OVERNIGHT_MAX) : "",
    decisions: clampItems(r.decisions, RUNDOWN_DECISIONS_CAP),
    ciRework: clampItems(r.ciRework, RUNDOWN_CIREWORK_CAP),
    train: typeof r.train === "string" ? r.train.slice(0, RUNDOWN_TRAIN_MAX) : "",
    focusNext: clampItems(r.focusNext, RUNDOWN_FOCUSNEXT_CAP),
  };
}
