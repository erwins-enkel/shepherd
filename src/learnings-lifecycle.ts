/**
 * Pure math + orchestration for learnings auto-retire.
 * No direct store/DB imports — all I/O injected via deps.
 * Every constant is env-overridable for production tuning without code changes.
 */

import type { Learning, ReviewVerdict } from "./types";
import type { SessionStore } from "./store";
import type { OptimizerService } from "./optimizer";

// ── tuning constants ──────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

// auto-trial kill switch (default ON)
export const AUTO_TRIAL_ENABLED = process.env.SHEPHERD_LEARNINGS_AUTO_TRIAL !== "0";

// strength gate
export const TRIAL_NMIN = Number(process.env.SHEPHERD_LEARNINGS_TRIAL_NMIN ?? 4);
export const TRIAL_SESSION_FLOOR = Number(process.env.SHEPHERD_LEARNINGS_TRIAL_SESSION_FLOOR ?? 2);
export const TRIAL_MIN_KINDS = Number(process.env.SHEPHERD_LEARNINGS_TRIAL_MIN_KINDS ?? 2);
export const TRIAL_MIN_SESSIONS = Number(process.env.SHEPHERD_LEARNINGS_TRIAL_MIN_SESSIONS ?? 3);
export const MAX_TRIAL_PER_SWEEP = Number(process.env.SHEPHERD_LEARNINGS_MAX_TRIAL_PER_SWEEP ?? 3);

// trial reaper
export const TRIAL_REAP_NMIN = Number(process.env.SHEPHERD_LEARNINGS_TRIAL_REAP_NMIN ?? 8);
export const TRIAL_REAP_DAYS = Number(process.env.SHEPHERD_LEARNINGS_TRIAL_REAP_DAYS ?? 21);
export const TRIAL_REAP_MAX_DAYS = Number(process.env.SHEPHERD_LEARNINGS_TRIAL_REAP_MAX_DAYS ?? 60);
export const MAX_REAP_PER_SWEEP = Number(process.env.SHEPHERD_LEARNINGS_MAX_REAP_PER_SWEEP ?? 5);

/**
 * Relevance branch (#2382): how many times the judge must have ruled on a trial — finding it
 * relevant in NONE of them — before that counts as a trial failed.
 *
 * Mirrors {@link TRIAL_REAP_NMIN} so "enough exposure to judge a trial" stays one number. Clamped
 * to >= 1 because the floor is what makes the branch fail closed on an unarmed gate: a floor of 0
 * would let a rule nobody has ever judged (`judged === 0`, `relevant === 0`) satisfy it, turning
 * "no signal" into "never relevant" — the one inversion {@link isJudgedIrrelevant} promises cannot
 * happen. The predicate rejects `judged <= 0` on its own too, so neither guard is load-bearing
 * alone.
 *
 * A non-finite override falls back to 8 rather than clamping: `Math.max(1, NaN)` is NaN, and every
 * comparison against NaN is false — which would skip the floor check entirely instead of raising
 * it. The other reaper constants can afford a bare `Number()` because a NaN there fails closed
 * (nothing is reaped); here it would fail open.
 */
export const TRIAL_RELEVANCE_MIN_JUDGED = Math.max(
  1,
  finiteOr(Number(process.env.SHEPHERD_LEARNINGS_TRIAL_RELEVANCE_MIN_JUDGED ?? TRIAL_REAP_NMIN), 8),
);

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

// proposed retention (#1794): permanently prune proposed learnings whose latest evidence is
// older than this many days. Applied in full each sweep (no cap, no exemption).
export const PRUNE_DAYS = resolveProposedRetentionDays(
  process.env.SHEPHERD_LEARNINGS_PRUNE_DAYS,
  3,
);

/** Informational reason stored when a stale trial is reaped; reapStaleTrial sets it in-store. */
export const TRIAL_EXPIRED_REASON = "trial-expired";

/** Reason stored when the relevance branch (#2382) fails a trial the judge never found relevant —
 *  distinct from {@link TRIAL_EXPIRED_REASON} so a retirement names its actual cause. Server-side
 *  legibility only: nothing in `ui/` reads `retiredReason`. */
export const TRIAL_IRRELEVANT_REASON = "trial-irrelevant";

export const WILSON_Z = Number(process.env.SHEPHERD_LEARNINGS_WILSON_Z ?? 1.96);
export const RETIRE_N_MIN = Number(process.env.SHEPHERD_LEARNINGS_RETIRE_NMIN ?? 8);
export const DEFAULT_BASE_RATE = Number(process.env.SHEPHERD_LEARNINGS_BASE_RATE ?? 0.5);
export const BASE_RATE_MIN_N = Number(process.env.SHEPHERD_LEARNINGS_BASE_RATE_MIN_N ?? 20);
export const MAX_RETIRE_PER_SWEEP = Number(
  process.env.SHEPHERD_LEARNINGS_MAX_RETIRE_PER_SWEEP ?? 3,
);
/** Machine code stored in retiredReason; UI composes the sentence from the rule's counters. */
export const AUTO_RETIRE_REASON = "auto-retire";

// ── types ─────────────────────────────────────────────────────────────────────

export interface TrialedRecord {
  repoPath: string;
  id: string;
  rule: string;
  evidenceCount: number;
  distinctKinds: number;
  distinctSessions: number;
}

export interface ReapedRecord {
  repoPath: string;
  id: string;
  rule: string;
  injectedCount: number;
  /** Which branch fired — {@link TRIAL_EXPIRED_REASON} or {@link TRIAL_IRRELEVANT_REASON}. Also the
   *  value written to `retiredReason`. */
  reason: string;
}

export interface RetiredRecord {
  repoPath: string;
  id: string;
  rule: string;
  helpfulCount: number;
  injectedCount: number;
  ineffectiveCount: number;
}

export interface AutoRetireDeps {
  store: Pick<
    SessionStore,
    | "listRepoPathsWithInjectableLearnings"
    | "listActiveLearnings"
    | "listRetiredLearnings"
    | "getRepoConfig"
    | "autoOptimizedAt"
    | "retireLearning"
  >;
  optimizer: Pick<OptimizerService, "optimizeOne">;
  nMin?: number;
  maxRetirePerSweep?: number;
  baseRateOpts?: { defaultRate?: number; minN?: number };
}

// ── wilsonLowerBound ──────────────────────────────────────────────────────────

/**
 * Wilson score interval lower bound on the success proportion.
 *
 * p̂ = helpful / n
 * w⁻ = ( p̂ + z²/(2n) − z·√( p̂(1−p̂)/n + z²/(4n²) ) ) / ( 1 + z²/n )
 *
 * n ≤ 0 → 0 (no evidence ⇒ lowest confidence).
 * Result clamped to [0, 1].
 */
export function wilsonLowerBound(helpful: number, n: number, z = WILSON_Z): number {
  if (n <= 0) return 0;
  const phat = helpful / n;
  const z2 = z * z;
  const numerator = phat + z2 / (2 * n) - z * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n));
  const denominator = 1 + z2 / n;
  return Math.min(1, Math.max(0, numerator / denominator));
}

// ── isGoodOutcome ─────────────────────────────────────────────────────────────

/**
 * Returns true when the review verdict (or absence of review) indicates a clean outcome:
 * - `commented` with no findings, OR
 * - no review at all and no blocking signals.
 */
export function isGoodOutcome(review: ReviewVerdict | null, blockingSignalCount: number): boolean {
  if (review === null) return blockingSignalCount === 0;
  return review.decision === "commented" && review.findings.length === 0;
}

// ── repoBaseRate ──────────────────────────────────────────────────────────────

/**
 * Compute the repo's base helpful rate across ALL rules (active + promoted + retired).
 * Using all rules (not just active) prevents a survivorship cascade where retiring
 * bad rules inflates the base rate, then that higher rate retires the next-worst, etc.
 *
 * Only rules with injectedCount > 0 contribute to the denominator.
 * Unproven trials (trialedAt set, helpfulCount=0) are excluded — they carry no proven
 * signal and would only inflate the denominator with a 0 numerator, dragging the base
 * rate down unfairly.
 * If total injected < minN, falls back to defaultRate (not enough data).
 */
export function repoBaseRate(
  rules: Learning[],
  opts?: { defaultRate?: number; minN?: number },
): number {
  const defaultRate = opts?.defaultRate ?? DEFAULT_BASE_RATE;
  const minN = opts?.minN ?? BASE_RATE_MIN_N;

  let totalInjected = 0;
  let totalHelpful = 0;
  for (const r of rules) {
    if (r.injectedCount > 0 && !isUnprovenTrial(r)) {
      totalInjected += r.injectedCount;
      totalHelpful += r.helpfulCount;
    }
  }

  if (totalInjected < minN) return defaultRate;
  return totalHelpful / totalInjected;
}

// ── isUnprovenTrial ───────────────────────────────────────────────────────────

/** Single source of truth for "auto-trialed but not yet proven helpful". Task 4 imports this. */
export function isUnprovenTrial(rule: Learning): boolean {
  return rule.trialedAt != null && rule.helpfulCount === 0;
}

// ── shouldTrial ───────────────────────────────────────────────────────────────

export function shouldTrial(
  rule: Learning,
  opts?: { nMin?: number; sessionFloor?: number; minKinds?: number; minSessions?: number },
): boolean {
  if (rule.status !== "proposed") return false;
  // #945: a reverted-to-proposed trial is blocked from auto-re-trial until genuinely fresh
  // evidence clears the marker (accrueProposedEvidence) or the rule expires. Presence-only —
  // the timestamp value is never compared to `now`, so no cooldown-vs-expire coupling exists.
  if (rule.reTrialBlockedAt != null) return false;
  const K = opts?.nMin ?? TRIAL_NMIN;
  const floor = opts?.sessionFloor ?? TRIAL_SESSION_FLOOR;
  const minKinds = opts?.minKinds ?? TRIAL_MIN_KINDS;
  const M = opts?.minSessions ?? TRIAL_MIN_SESSIONS;
  if (rule.evidenceCount < K) return false;
  if (rule.distinctSessions < floor) return false; // hard floor: no single-session trial
  return rule.distinctKinds >= minKinds || rule.distinctSessions >= M;
}

// ── runAutoTrial ──────────────────────────────────────────────────────────────

export interface AutoTrialDeps {
  store: Pick<SessionStore, "listPendingLearnings" | "getRepoConfig" | "trialLearning">;
  enabled?: boolean; // default AUTO_TRIAL_ENABLED (test-injectable kill switch)
  maxPerSweep?: number;
  gate?: { nMin?: number; sessionFloor?: number; minKinds?: number; minSessions?: number };
}

export function runAutoTrial(deps: AutoTrialDeps): TrialedRecord[] {
  const enabled = deps.enabled ?? AUTO_TRIAL_ENABLED;
  if (!enabled) return [];
  const cap = deps.maxPerSweep ?? MAX_TRIAL_PER_SWEEP;
  const out: TrialedRecord[] = [];
  for (const rule of deps.store.listPendingLearnings()) {
    // already strongest-first
    if (out.length >= cap) break;
    if (!deps.store.getRepoConfig(rule.repoPath).learningsEnabled) continue;
    if (!shouldTrial(rule, deps.gate)) continue;
    const trialed = deps.store.trialLearning(rule.id);
    if (trialed)
      out.push({
        repoPath: rule.repoPath,
        id: rule.id,
        rule: rule.rule,
        evidenceCount: rule.evidenceCount,
        distinctKinds: rule.distinctKinds,
        distinctSessions: rule.distinctSessions,
      });
  }
  return out;
}

// ── runProposedPrune (#1794) ──────────────────────────────────────────────────

export interface ProposedPruneDeps {
  store: Pick<SessionStore, "pruneStaleProposedLearnings">;
  now?: number;
  retentionDays?: number;
}

/** Resolve a configured retention window without allowing malformed overrides to make the
 *  cutoff destructive or disable pruning. Invalid explicit values fall back visibly. */
export function resolveProposedRetentionDays(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === "string" && value.trim() === "" ? Number.NaN : Number(value);
  const durationMs = parsed * DAY_MS;
  if (Number.isFinite(parsed) && parsed > 0 && Number.isFinite(durationMs) && durationMs >= 1)
    return parsed;
  const shown = typeof value === "string" ? JSON.stringify(value) : String(value);
  console.warn(`[learnings] invalid proposed retention days ${shown}; using ${fallback}`);
  return fallback;
}

/** Permanently delete every `proposed` learning whose latest evidence is older than the
 *  retention window (age = COALESCE(lastEvidenceAt, createdAt)). One global, status-scoped,
 *  uncapped bulk delete — no per-repo gate and no exemption for strong/trial-worthy proposals.
 *  Runs before auto-trial in the sweep, so a strong-but-stale proposal is dropped rather than
 *  promoted; genuinely recurring evidence re-proposes it later. Returns the number removed. */
export function runProposedPrune(deps: ProposedPruneDeps): number {
  const now = deps.now ?? Date.now();
  const days = resolveProposedRetentionDays(deps.retentionDays, PRUNE_DAYS);
  const cutoff = now - days * DAY_MS;
  if (!Number.isFinite(cutoff)) {
    console.warn("[learnings] invalid proposed retention cutoff; skipping prune");
    return 0;
  }
  return deps.store.pruneStaleProposedLearnings(cutoff, now);
}

// ── shouldReapTrial + runReapStaleTrials ──────────────────────────────────────

export function shouldReapTrial(
  rule: Learning,
  now: number,
  opts?: { reapNmin?: number; reapDays?: number; reapMaxDays?: number },
): boolean {
  if (rule.trialedAt == null || rule.status !== "active") return false;
  if (rule.helpfulCount > 0) return false; // graduated (proven) — leave it
  const reapNmin = opts?.reapNmin ?? TRIAL_REAP_NMIN;
  const reapDays = opts?.reapDays ?? TRIAL_REAP_DAYS;
  const maxDays = opts?.reapMaxDays ?? TRIAL_REAP_MAX_DAYS;
  const age = now - rule.trialedAt;
  const injectionBranch = rule.injectedCount >= reapNmin && age > reapDays * DAY_MS;
  const timeBranch = age > maxDays * DAY_MS; // fallback: no zombies even if budget-starved
  return injectionBranch || timeBranch;
}

// ── isJudgedIrrelevant (#2382) ────────────────────────────────────────────────

/** One rule's relevance history, as `SessionStore.learningRelevanceStats` tallies it: how many
 *  sessions the judge was asked about the rule, and in how many it answered relevant. */
export interface TrialRelevance {
  judged: number;
  relevant: number;
}

/**
 * The relevance branch of the trial reaper: a trial the judge has ruled on enough times and found
 * relevant in NONE of them has failed, whatever its age or injection count.
 *
 * WHAT THIS ADDS THAT {@link shouldReapTrial} CANNOT. Both of that function's branches measure
 * EXPOSURE — injections accrued, days elapsed. Under `enforce`, a rule the judge rules out is not
 * injected at all, so `injectedCount` never grows and its evidence branch can never fire; the rule
 * survives to the 60-day `reapMaxDays` fallback. This branch is the only one that reaches it. Under
 * `shadow` the rule IS injected, so the evidence branch would reach it at 21 days and this merely
 * accelerates — and only where two independent signals agree: never judged relevant, never marked
 * helpful.
 *
 * FAILS CLOSED ON NO SIGNAL, twice over. `judged <= 0` is rejected here, independent of
 * {@link TRIAL_RELEVANCE_MIN_JUDGED}'s own >= 1 clamp, because the whole feature rests on zero
 * verdicts meaning "nobody asked" and never "never relevant" — and callers may pass their own
 * floor. A corpus whose operator has never armed the gate reads `judged === 0` for every rule and
 * is therefore untouched by construction, not by configuration.
 *
 * Scope and exemptions are {@link shouldReapTrial}'s, deliberately: active auto-trials only
 * (`trialedAt != null`), and a trial that was ever marked helpful is never reaped, whatever the
 * judge thinks of it.
 */
export function isJudgedIrrelevant(
  rule: Learning,
  relevance: TrialRelevance | undefined,
  minJudged = TRIAL_RELEVANCE_MIN_JUDGED,
): boolean {
  if (rule.trialedAt == null || rule.status !== "active") return false;
  if (rule.helpfulCount > 0) return false; // graduated (proven) — leave it
  if (!relevance || relevance.judged <= 0) return false; // no verdicts ⇒ no signal
  if (relevance.judged < minJudged) return false;
  return relevance.relevant === 0;
}

export interface ReapTrialDeps {
  store: Pick<
    SessionStore,
    "listTrialLearnings" | "getRepoConfig" | "reapStaleTrial" | "learningRelevanceStats"
  >;
  now?: number;
  maxPerSweep?: number;
  reap?: { reapNmin?: number; reapDays?: number; reapMaxDays?: number };
  /** Whether the relevance gate is armed (`config.houseRuleRelevance !== "off"`), passed in so this
   *  module stays config-free. Default false: the relevance branch is skipped entirely — including
   *  its store read — unless the operator has armed the capability that produces its signal. */
  relevanceArmed?: boolean;
  minJudged?: number;
}

export function runReapStaleTrials(deps: ReapTrialDeps): ReapedRecord[] {
  const now = deps.now ?? Date.now();
  const cap = deps.maxPerSweep ?? MAX_REAP_PER_SWEEP;
  const out: ReapedRecord[] = [];
  // listTrialLearnings is cross-repo but learningRelevanceStats is per-repo, so memoize: one query
  // per distinct repoPath per sweep, not one per rule.
  const statsByRepo = new Map<string, Map<string, TrialRelevance>>();
  const relevanceFor = (repoPath: string, id: string): TrialRelevance | undefined => {
    let stats = statsByRepo.get(repoPath);
    if (!stats) {
      stats = deps.store.learningRelevanceStats(repoPath);
      statsByRepo.set(repoPath, stats);
    }
    return stats.get(id);
  };

  for (const rule of deps.store.listTrialLearnings()) {
    // oldest-trial first
    if (out.length >= cap) break;
    if (!deps.store.getRepoConfig(rule.repoPath).learningsEnabled) continue;
    // Relevance first: a rule qualifying on both branches is retired under the reason that names
    // its actual cause.
    const irrelevant =
      deps.relevanceArmed === true &&
      isJudgedIrrelevant(rule, relevanceFor(rule.repoPath, rule.id), deps.minJudged);
    if (!irrelevant && !shouldReapTrial(rule, now, deps.reap)) continue;
    const reason = irrelevant ? TRIAL_IRRELEVANT_REASON : TRIAL_EXPIRED_REASON;
    if (deps.store.reapStaleTrial(rule.id, reason))
      out.push({
        repoPath: rule.repoPath,
        id: rule.id,
        rule: rule.rule,
        injectedCount: rule.injectedCount,
        reason,
      });
  }
  return out;
}

// ── shouldRetire ──────────────────────────────────────────────────────────────

/**
 * A rule should be auto-retired when:
 * 1. It has been flagged ineffective at least once (ineffectiveCount > 0).
 * 2. There is enough injection data (injectedCount >= nMin).
 * 3. Its Wilson lower bound on helpfulness is below the repo base rate.
 *
 * All three gates must hold simultaneously.
 */
export function shouldRetire(
  rule: Learning,
  baseRate: number,
  opts?: { nMin?: number; z?: number },
): boolean {
  if (rule.ineffectiveCount <= 0) return false;
  if (rule.injectedCount < (opts?.nMin ?? RETIRE_N_MIN)) return false;
  return wilsonLowerBound(rule.helpfulCount, rule.injectedCount, opts?.z ?? WILSON_Z) < baseRate;
}

// ── runAutoRetire ─────────────────────────────────────────────────────────────

/**
 * Cross-repo sweep: identify and retire underperforming active learnings.
 *
 * For each repo path:
 * 1. Fetch active+promoted rules (injected set) and retired rules.
 * 2. Compute the base rate using all rules (incl. retired) to prevent cascade.
 * 3. Filter to ACTIVE-only candidates (promoted rules keep a verbatim CLAUDE.md copy;
 *    retiring them is inert — leave them alone).
 * 4. Sort worst-first (lowest Wilson bound) so the budget cap retires the worst rules.
 * 5. For each shouldRetire candidate:
 *    - If autoOptimizeFlagged and not yet optimized: optimizeOne (no retire, no budget hit).
 *    - Else if budget remains: retire it and increment the per-repo counter.
 *
 * Returns flat array of RetiredRecord across all repos.
 */
export function runAutoRetire(deps: AutoRetireDeps): RetiredRecord[] {
  const { store, baseRateOpts } = deps;
  const nMin = deps.nMin ?? RETIRE_N_MIN;
  const maxRetirePerSweep = deps.maxRetirePerSweep ?? MAX_RETIRE_PER_SWEEP;

  const results: RetiredRecord[] = [];

  for (const repoPath of store.listRepoPathsWithInjectableLearnings()) {
    // Injection-driven lifecycle paths (auto-trial, trial reaping, optimize, retire) stay
    // dormant for learnings-disabled repos. The global proposed-prune pass is the intentional
    // exception: it is status/age-based and not gated by repository configuration.
    if (!store.getRepoConfig(repoPath).learningsEnabled) continue;
    results.push(
      ...retireRepoCandidates(repoPath, deps, { nMin, maxRetirePerSweep, baseRateOpts }),
    );
  }

  return results;
}

/** Per-repo body of runAutoRetire: score active candidates worst-first, then optimize-or-retire
 *  each under the budget cap. Extracted so the cross-repo loop stays flat. */
function retireRepoCandidates(
  repoPath: string,
  deps: AutoRetireDeps,
  opts: { nMin: number; maxRetirePerSweep: number; baseRateOpts?: AutoRetireDeps["baseRateOpts"] },
): RetiredRecord[] {
  const { store, optimizer } = deps;
  const { nMin, maxRetirePerSweep, baseRateOpts } = opts;

  const injected = store.listActiveLearnings(repoPath); // active + promoted
  const retiredList = store.listRetiredLearnings(repoPath);
  const base = repoBaseRate([...injected, ...retiredList], baseRateOpts);
  const autoOptimizeFlagged = store.getRepoConfig(repoPath).autoOptimizeFlagged;

  // Candidates: active only (not promoted), worst-first so the budget cap retires the worst.
  const candidates = injected
    .filter((r) => r.status === "active")
    .sort(
      (a, b) =>
        wilsonLowerBound(a.helpfulCount, a.injectedCount) -
        wilsonLowerBound(b.helpfulCount, b.injectedCount),
    );

  const out: RetiredRecord[] = [];
  let retiredThisSweep = 0;

  for (const rule of candidates) {
    if (!shouldRetire(rule, base, { nMin })) continue;

    if (autoOptimizeFlagged && store.autoOptimizedAt(rule.id) === null) {
      // Enqueue rewrite; do not retire yet, do not consume budget
      void optimizer.optimizeOne(rule.id);
    } else if (retiredThisSweep < maxRetirePerSweep) {
      const retiredRow = store.retireLearning(rule.id, AUTO_RETIRE_REASON);
      if (retiredRow !== null) {
        out.push({
          repoPath,
          id: rule.id,
          rule: rule.rule,
          helpfulCount: rule.helpfulCount,
          injectedCount: rule.injectedCount,
          ineffectiveCount: rule.ineffectiveCount,
        });
        retiredThisSweep++;
      }
    }
  }

  return out;
}
