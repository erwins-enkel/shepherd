// Pure seed data for the Usage lens — the Spend/Overhead breakdown, the Timeline
// heatmap, the Delivery metrics, the GitHub rate-limit buckets and the per-spawn
// prompt budgets. Split out of `seed.ts` (#2295) for the same reason as the repo-lens
// fixtures: `seed.ts` narrates the herd, this narrates the analytics over it.
//
// This lens is the reason #2295 mattered most. `Usage.svelte`'s five loaders each wrap
// their call in try/catch — but a `{}` body from the router's permissive tail is
// `r.ok`, so NOTHING throws at fetch time. `{}` lands in `$state` and the render
// `$derived` throws on `.repos` / `.hours` / `.satelliteByKind` INSIDE Svelte's flush,
// which aborts the batch and freezes every queued effect in the app. Shape is not
// polish here; it is the bug.
//
// RANGE: `UsageRange` is `24h | 7d | 30d | all`, but these are single datasets and the
// getters in `state.ts` echo the requested range back into the response's `range`
// field. Seeding four variants would quadruple the fixture to demonstrate arithmetic
// the demo is not showing off; the lens itself is the subject. Deliberate, not an
// oversight.

import type {
  UsageBreakdown,
  UsageTaskBreakdown,
  UsageTimeline,
  UsageTimelineHour,
  DeliveryMetrics,
  DeliveryStats,
  GithubRateLimit,
  PromptBudgetRecord,
} from "$lib/types";
import { STOREFRONT, API, NOW, HOUR, DAY } from "./seed-constants";

/** One task row of a repo's breakdown. `tokens` is the raw authoring detail behind
 *  `authoringUnits`; the cacheRead-heavy split is what real Claude Code usage looks like
 *  (see the token-usage analysis in #496 — cacheRead dominates), so a demo with an
 *  even split would misrepresent where the spend actually goes. */
function task(
  sessionId: string,
  desig: string,
  name: string,
  model: string,
  authoringUnits: number,
  satelliteUnits: number,
): UsageTaskBreakdown {
  const total = authoringUnits * 1000;
  return {
    sessionId,
    desig,
    name,
    model,
    authoringUnits,
    satelliteUnits,
    dollars: null,
    tokens: {
      input: Math.round(total * 0.04),
      output: Math.round(total * 0.05),
      cacheRead: Math.round(total * 0.83),
      cacheWrite: Math.round(total * 0.08),
    },
    byModel: { [model]: authoringUnits },
  };
}

/** GET /api/usage/breakdown?range= — the Spend and Overhead lenses.
 *
 *  `dollars` is null throughout: the demo operator is on subscription auth, and the
 *  lens renders absolute USD only under api-key auth. A seeded number here would
 *  advertise a spend figure the demo's own settings say cannot exist. */
export function buildUsageBreakdown(): UsageBreakdown {
  return {
    range: "7d",
    generatedAt: NOW,
    totalUnits: 4820,
    authoringUnits: 3910,
    satelliteUnits: 910,
    cacheReadUnits: 3480,
    generationUnits: 1340,
    satelliteByKind: [
      { kind: "review", units: 470, count: 14 },
      { kind: "plan_gate", units: 240, count: 9 },
      { kind: "recap", units: 110, count: 6 },
      { kind: "classifier", units: 55, count: 41 },
      { kind: "maintain", units: 35, count: 2 },
    ],
    dollars: null,
    models: {
      claude: {
        totalTokens: 41_250_000,
        byModel: { opus: 28_400_000, sonnet: 12_850_000 },
        byRole: {
          coding: { opus: 26_100_000, sonnet: 6_200_000 },
          review: { opus: 2_300_000, sonnet: 3_400_000 },
          plan_gate: { sonnet: 2_050_000 },
          recap: { sonnet: 900_000 },
          classifier: { sonnet: 300_000 },
        },
      },
      codex: {
        totalTokens: 3_900_000,
        byModel: { "gpt-5.2-codex": 3_900_000 },
        byRole: { coding: { "gpt-5.2-codex": 3_900_000 } },
      },
    },
    repos: [
      {
        repoPath: STOREFRONT,
        repoName: "storefront",
        authoringUnits: 2980,
        satelliteUnits: 690,
        dollars: null,
        tasks: [
          task("coupon", "TASK-40", "coupon-code-field", "opus", 980, 120),
          task("rounding", "TASK-38", "cart-total-rounding", "opus", 610, 190),
          task("ogimg", "TASK-39", "dynamic-og-images", "opus", 540, 150),
          task("deps", "TASK-37", "bump-dependencies", "sonnet", 470, 130),
          task("envflag", "TASK-50", "feature-x-env-flag", "opus", 380, 100),
        ],
      },
      {
        repoPath: API,
        repoName: "api",
        authoringUnits: 930,
        satelliteUnits: 220,
        dollars: null,
        tasks: [
          task("authstore", "TASK-42", "auth-store-rewrite", "opus", 530, 140),
          task("neon", "TASK-43", "neon-cold-start-retry", "opus", 400, 80),
        ],
      },
    ],
  };
}

/** GET /api/usage/timeline?range= — the per-hour heatmap. Only non-empty hours are
 *  returned (the real server excludes idle hours rather than padding with zeros), so
 *  the seeded run below has deliberate gaps where the operator was asleep. */
export function buildUsageTimeline(): UsageTimeline {
  // Weighted units per hour, newest-last, walking back from the seed anchor. Zeros are
  // DROPPED below, not emitted — an absent hour and a zero hour mean different things
  // to this lens.
  const perHour = [
    120, 180, 240, 90, 0, 0, 0, 0, 0, 0, 30, 210, 320, 410, 280, 190, 150, 220, 380, 450, 300, 160,
    80, 40,
  ];
  const hours: UsageTimelineHour[] = [];
  for (const [i, units] of perHour.entries()) {
    if (units === 0) continue;
    hours.push({ hourStart: NOW - (perHour.length - 1 - i) * HOUR, units });
  }
  const totalUnits = hours.reduce((sum, h) => sum + h.units, 0);
  return {
    range: "24h",
    generatedAt: NOW,
    hours,
    totalUnits,
    peakHourUnits: Math.max(...hours.map((h) => h.units)),
  };
}

/** GET /api/usage/github — the rate-limit buckets. Healthy and un-throttled: a demo
 *  that opens on an exhausted bucket reads as a broken product, not a busy one. */
export function buildGithubRateLimit(): GithubRateLimit {
  return {
    rest: { limit: 5000, used: 1240, remaining: 3760, resetAt: NOW + 38 * 60_000 },
    graphql: { limit: 5000, used: 890, remaining: 4110, resetAt: NOW + 38 * 60_000 },
    search: { limit: 30, used: 4, remaining: 26, resetAt: NOW + 60_000 },
    fetchedAt: NOW - 45_000,
    backoff: { remaining: 4110, resetAt: NOW + 38 * 60_000, pausedUntil: null, blocked: false },
  };
}

/** A measured metric plus its sample size. `null` renders an em dash, never a zero —
 *  an unmeasured window must not read as a measured one. */
const sample = (value: number | null, n: number) => ({ value, n });

function storefrontStats(): DeliveryStats {
  return {
    mergedTasks: 14,
    firstPassRate: sample(0.64, 14),
    unreviewed: 1,
    reworkCyclesMedian: sample(1, 13),
    reworkCyclesMean: sample(1.38, 13),
    criticErrors: 1,
    planRoundsMedian: sample(1, 8),
    planReworkRate: sample(0.25, 8),
    planDriftRate: sample(0.12, 8),
    planDriftMajor: 0,
    timeToFirstReviewMs: sample(11 * 60_000, 13),
    leadTimeMs: sample(3.2 * HOUR, 14),
    firstPushGreenRate: sample(0.71, 14),
  };
}

function apiStats(): DeliveryStats {
  return {
    mergedTasks: 5,
    firstPassRate: sample(0.4, 5),
    unreviewed: 0,
    reworkCyclesMedian: sample(2, 5),
    reworkCyclesMean: sample(1.8, 5),
    criticErrors: 0,
    planRoundsMedian: sample(1, 3),
    planReworkRate: sample(0.33, 3),
    planDriftRate: sample(null, 0),
    planDriftMajor: 0,
    timeToFirstReviewMs: sample(19 * 60_000, 5),
    leadTimeMs: sample(5.1 * HOUR, 5),
    // `api` has no CI at all (see its readiness report: the `ci` guardrail is absent), so
    // Shepherd never observed a first-push conclusion there. Null + n:0, NOT a zero rate —
    // an unmeasured repo must render an em dash, not score red.
    firstPushGreenRate: sample(null, 0),
  };
}

/** GET /api/usage/delivery?range= — the Delivery lens. Totals are the two repo rows
 *  summed where summing is meaningful (counts) and re-derived where it is not
 *  (rates/medians are over the pooled sample, not an average of averages). */
export function buildDeliveryMetrics(): DeliveryMetrics {
  const sf = storefrontStats();
  const api = apiStats();
  return {
    range: "7d",
    generatedAt: NOW,
    since: NOW - 7 * DAY,
    measuringSince: NOW - 23 * DAY,
    totals: {
      mergedTasks: 19,
      firstPassRate: sample(0.58, 19),
      unreviewed: 1,
      reworkCyclesMedian: sample(1, 18),
      reworkCyclesMean: sample(1.5, 18),
      criticErrors: 1,
      planRoundsMedian: sample(1, 11),
      planReworkRate: sample(0.27, 11),
      planDriftRate: sample(0.12, 8),
      planDriftMajor: 0,
      timeToFirstReviewMs: sample(13 * 60_000, 18),
      leadTimeMs: sample(3.7 * HOUR, 19),
      firstPushGreenRate: sample(0.71, 14),
    },
    repos: [
      { ...sf, repoPath: STOREFRONT, repo: "storefront" },
      { ...api, repoPath: API, repo: "api" },
    ],
    incidents: [
      { kind: "review_rework", occurrences: 9, sessions: 6 },
      { kind: "ci_red", occurrences: 5, sessions: 4 },
      { kind: "plan_rework", occurrences: 3, sessions: 3 },
      { kind: "critic_error", occurrences: 1, sessions: 1 },
    ],
    trend: [
      { dayKey: "2026-06-24", mergedTasks: 2, firstPassRate: 0.5, leadTimeMedianMs: 4.4 * HOUR },
      { dayKey: "2026-06-25", mergedTasks: 4, firstPassRate: 0.75, leadTimeMedianMs: 3.1 * HOUR },
      { dayKey: "2026-06-26", mergedTasks: 1, firstPassRate: 0, leadTimeMedianMs: 6.8 * HOUR },
      { dayKey: "2026-06-27", mergedTasks: 3, firstPassRate: 0.67, leadTimeMedianMs: 3.5 * HOUR },
      { dayKey: "2026-06-28", mergedTasks: 0, firstPassRate: null, leadTimeMedianMs: null },
      { dayKey: "2026-06-29", mergedTasks: 5, firstPassRate: 0.6, leadTimeMedianMs: 2.9 * HOUR },
      { dayKey: "2026-06-30", mergedTasks: 4, firstPassRate: 0.5, leadTimeMedianMs: 3.4 * HOUR },
    ],
    // Newest-merged first, and keyed to sessions the herd actually shows as merged
    // (`deps` PR 505, `envflag` PR 520) so a visitor can follow a row back to its card.
    tasks: [
      {
        sessionId: "deps",
        desig: "TASK-37",
        repo: "storefront",
        issueNumber: 137,
        prNumber: 505,
        reviewRounds: 1,
        planRounds: 0,
        firstPass: true,
        timeToFirstReviewMs: 9 * 60_000,
        leadTimeMs: 2.4 * HOUR,
        mergedAt: NOW - 4 * HOUR,
      },
      {
        sessionId: "envflag",
        desig: "TASK-50",
        repo: "storefront",
        issueNumber: 150,
        prNumber: 520,
        reviewRounds: 2,
        planRounds: 1,
        firstPass: false,
        timeToFirstReviewMs: 14 * 60_000,
        leadTimeMs: 6.1 * HOUR,
        mergedAt: NOW - 7 * HOUR,
      },
      {
        sessionId: "cart-store",
        desig: "TASK-31",
        repo: "storefront",
        issueNumber: 81,
        prNumber: 390,
        reviewRounds: 1,
        planRounds: 1,
        firstPass: true,
        timeToFirstReviewMs: 8 * 60_000,
        leadTimeMs: 3.9 * HOUR,
        mergedAt: NOW - 2 * DAY - 2 * HOUR,
      },
      {
        sessionId: "ratelimit",
        desig: "TASK-28",
        repo: "api",
        issueNumber: 201,
        prNumber: 310,
        reviewRounds: 3,
        planRounds: 1,
        firstPass: false,
        timeToFirstReviewMs: 22 * 60_000,
        leadTimeMs: 7.8 * HOUR,
        mergedAt: NOW - 5 * DAY,
      },
    ],
  };
}

/** GET /api/prompt-budget — the Prompt tab's per-spawn assembled-directive breakdown.
 *  One attended Claude spawn and one unattended (drain) Codex spawn, so the tab shows
 *  both `delivery` modes: Claude takes the payload on `--append-system-prompt`, Codex
 *  inline on the prompt (it has no such flag). */
export function buildPromptBudgets(): PromptBudgetRecord[] {
  return [
    {
      sessionId: "coupon",
      desig: "TASK-40",
      repoPath: STOREFRONT,
      agentProvider: "claude",
      auto: false,
      delivery: "append-system-prompt",
      totalChars: 18_420,
      totalBytes: 18_650,
      totalTokens: 4720,
      blocks: [
        { name: "house-rules", chars: 6100, bytes: 6180, tokens: 1560 },
        { name: "learnings", chars: 4830, bytes: 4900, tokens: 1240 },
        { name: "task", chars: 3910, bytes: 3960, tokens: 1000 },
        { name: "repo-context", chars: 2400, bytes: 2430, tokens: 610 },
        { name: "conventions", chars: 1180, bytes: 1180, tokens: 310 },
      ],
      createdAt: NOW - 55 * 60_000,
    },
    {
      sessionId: "checkout-child",
      desig: "TASK-44",
      repoPath: STOREFRONT,
      agentProvider: "codex",
      auto: true,
      delivery: "inline-prompt",
      totalChars: 12_060,
      totalBytes: 12_180,
      totalTokens: 3090,
      blocks: [
        { name: "house-rules", chars: 6100, bytes: 6180, tokens: 1560 },
        { name: "task", chars: 3560, bytes: 3600, tokens: 910 },
        { name: "repo-context", chars: 2400, bytes: 2400, tokens: 620 },
      ],
      createdAt: NOW - 21 * 60_000,
    },
  ];
}
