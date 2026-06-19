/**
 * Pure math + orchestration for learnings auto-retire.
 * No direct store/DB imports — all I/O injected via deps.
 * Every constant is env-overridable for production tuning without code changes.
 */

import type { Learning, ReviewVerdict } from "./types";
import type { SessionStore } from "./store";
import type { OptimizerService } from "./optimizer";

// ── tuning constants ──────────────────────────────────────────────────────────

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
    if (r.injectedCount > 0) {
      totalInjected += r.injectedCount;
      totalHelpful += r.helpfulCount;
    }
  }

  if (totalInjected < minN) return defaultRate;
  return totalHelpful / totalInjected;
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
  const {
    store,
    optimizer,
    nMin = RETIRE_N_MIN,
    maxRetirePerSweep = MAX_RETIRE_PER_SWEEP,
    baseRateOpts,
  } = deps;

  const results: RetiredRecord[] = [];

  for (const repoPath of store.listRepoPathsWithInjectableLearnings()) {
    const injected = store.listActiveLearnings(repoPath); // active + promoted
    const retiredList = store.listRetiredLearnings(repoPath);

    const base = repoBaseRate([...injected, ...retiredList], baseRateOpts);

    // Candidates: active only (not promoted)
    const candidates = injected
      .filter((r) => r.status === "active")
      .sort(
        (a, b) =>
          wilsonLowerBound(a.helpfulCount, a.injectedCount) -
          wilsonLowerBound(b.helpfulCount, b.injectedCount),
      );

    const cfg = store.getRepoConfig(repoPath);
    let retiredThisSweep = 0;

    for (const rule of candidates) {
      if (!shouldRetire(rule, base, { nMin })) continue;

      if (cfg.autoOptimizeFlagged && store.autoOptimizedAt(rule.id) === null) {
        // Enqueue rewrite; do not retire yet, do not consume budget
        optimizer.optimizeOne(rule.id);
      } else if (retiredThisSweep < maxRetirePerSweep) {
        const retiredRow = store.retireLearning(rule.id, AUTO_RETIRE_REASON);
        if (retiredRow !== null) {
          results.push({
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
  }

  return results;
}
