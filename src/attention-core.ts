/**
 * Pure attention classification — no I/O, no DB, no spawn.
 *
 * Ranks what a session needs from a human into a tier + raw signal codes, and renders the
 * primary signal as the session's hold reason. Consumed by the live HoldReasonService
 * (`hold-service.ts`) and, for the merge predicate, by `ready-stage.ts`.
 */
import type { Session, ReviewVerdict, PlanGate, Recap, HoldReason } from "./types";
import type { GitState } from "./forge/types";
import type { BlockReason } from "./blocked";
import { blockReasonToHoldCode } from "./hold";
import { verdictStale } from "./verdict-freshness";
import { isDefiniteConflict } from "./pr-conflict";
import { addressStallStatus } from "./review-status";

// DRIFT: keep in sync with ui/src/lib/components/merge-train.ts (MERGE_MARK_BACKSTOP_MS).
// Re-implemented server-side so classification never imports UI code; a parity test in
// attention-core.test.ts locks the two literals together.
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
   *  detection reads terminal buffers / files, which belongs to the caller). Currently
   *  supplied by no caller: HoldReasonService's zero-I/O rule forbids the transcript probe
   *  that would derive it, so both this field and the `stalled` signal are inert on the
   *  live path. See the SCOPE note on the pr-conflict rule. */
  stalled?: boolean;
  /** Live BlockReason for this session (WS-only; supplied by the live HoldReasonService).
   *  Makes blocked-decision fire for a running-but-stalled session whose status hasn't
   *  flipped to "blocked". */
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
  // re-running them is futile; the actionable step is the rebase this line names. Recorded here
  // rather than only in the PR that introduced it, since this is the code that causes it and a
  // reader hitting "why did Retry CI disappear?" will land on this rule, not on a changelog.
  //
  // KNOWN GAP, deliberate: isDefiniteConflict is structurally always false on Gitea and
  // LocalForge (neither sets mergeStateStatus), so a genuinely conflicting PR there gets the
  // PRs-tab chip but no pr-conflict signal. Do not "fix" this by widening the predicate: on
  // Gitea `mergeable: false` cannot be told apart from branch protection, and this hold line
  // makes a specific actionable claim ("rebase it") that would then be wrong. A missing signal
  // is recoverable — the chip still marks the PR; a false instruction sends the operator to
  // rebase a PR that has no conflict. Closing it properly needs a per-forge conflict signal
  // Gitea does not currently expose.
  //
  // (!busy || stalled): a session actively RESOLVING its conflict is protected by the merge
  // train's busy gate and would otherwise show a Tier-1 line for the whole duration. A HUNG
  // session is running/blocked too, so `stalled` re-opens the signal for it.
  //
  // SCOPE: `stalled` has no producer. HoldReasonService — the only caller — builds its caches
  // with git/review/gate/recap/train/block only, because deriving the flag needs a sync
  // transcript probe per running session and the live service's zero-I/O single-loop rule
  // forbids it. So this qualifier degrades to plain `!busy` and a hung conflicting session
  // never renders THIS line. (The herd rundown used to supply the flag for its own digest;
  // it was removed, and nothing supplies it now.)
  //
  // That is not a coverage hole: the poller fires a `shape: "stall"` block for exactly that
  // session, which reaches HoldReasonService as `c.block` and lights `blocked-decision` — Tier 1
  // and listed ABOVE this rule, so it would win as the primary line even if `stalled` were wired
  // in. The live backstop is blocked-decision.
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
 *  session bears no attention signal at all. */
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
