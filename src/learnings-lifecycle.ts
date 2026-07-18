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

// proposed retention (#1794): permanently prune proposed learnings whose latest evidence is
// older than this many days. Applied in full each sweep (no cap, no exemption).
export const PRUNE_DAYS = Number(process.env.SHEPHERD_LEARNINGS_PRUNE_DAYS ?? 3);

/** Informational reason stored when a stale trial is reaped; reapStaleTrial sets it in-store. */
export const TRIAL_EXPIRED_REASON = "trial-expired";

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

/** Permanently delete every `proposed` learning whose latest evidence is older than the
 *  retention window (age = COALESCE(lastEvidenceAt, createdAt)). One global, status-scoped,
 *  uncapped bulk delete — no per-repo gate and no exemption for strong/trial-worthy proposals.
 *  Runs before auto-trial in the sweep, so a strong-but-stale proposal is dropped rather than
 *  promoted; genuinely recurring evidence re-proposes it later. Returns the number removed. */
export function runProposedPrune(deps: ProposedPruneDeps): number {
  const now = deps.now ?? Date.now();
  const days = deps.retentionDays ?? PRUNE_DAYS;
  return deps.store.pruneStaleProposedLearnings(now - days * DAY_MS);
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

export interface ReapTrialDeps {
  store: Pick<SessionStore, "listTrialLearnings" | "getRepoConfig" | "reapStaleTrial">;
  now?: number;
  maxPerSweep?: number;
  reap?: { reapNmin?: number; reapDays?: number; reapMaxDays?: number };
}

export function runReapStaleTrials(deps: ReapTrialDeps): ReapedRecord[] {
  const now = deps.now ?? Date.now();
  const cap = deps.maxPerSweep ?? MAX_REAP_PER_SWEEP;
  const out: ReapedRecord[] = [];
  for (const rule of deps.store.listTrialLearnings()) {
    // oldest-trial first
    if (out.length >= cap) break;
    if (!deps.store.getRepoConfig(rule.repoPath).learningsEnabled) continue;
    if (!shouldReapTrial(rule, now, deps.reap)) continue;
    if (deps.store.reapStaleTrial(rule.id))
      out.push({
        repoPath: rule.repoPath,
        id: rule.id,
        rule: rule.rule,
        injectedCount: rule.injectedCount,
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
    // Skip repos with learnings injection disabled entirely — consistent with the sibling
    // sweeps (runAutoTrial / reapStaleTrial / expireProposed), which all `continue` past
    // learnings-disabled repos. When the operator turns Learnings off, the whole rule
    // lifecycle (trial, optimize, retire) goes dormant for that repo, and no
    // `learnings_retired` notification fires. This also makes the UI's Auto-optimize gate
    // honest: with Learnings off the optimize pass never runs.
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
