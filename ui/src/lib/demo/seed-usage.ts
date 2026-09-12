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
// IDENTITY IS NEVER RE-DECLARED HERE. Every builder takes the seeded sessions and joins
// on `sessionId` for desig, name, model, provider, repo and issue number; the fixtures
// below carry ONLY the numbers — units, tokens, rounds, durations. A usage row is a
// view OF a session, and the Spend/Overhead/Prompt lenses render that identity next to
// the herd card it belongs to, so a second hand-written copy of it is not a shortcut,
// it is a future contradiction. (It already was one: an earlier draft invented TASK-40
// and TASK-43, and swapped TASK-42/TASK-44 between two sessions.)
//
// RANGE: `UsageRange` is `24h | 7d | 30d | all`, but these are single datasets and the
// getters in `state.ts` echo the requested range back into the response's `range`
// field. Seeding four variants would quadruple the fixture to demonstrate arithmetic
// the demo is not showing off; the lens itself is the subject. Deliberate, not an
// oversight.

import type {
  Session,
  GitState,
  UsageBreakdown,
  UsageByRole,
  UsageRole,
  UsageTaskBreakdown,
  UsageTimeline,
  UsageTimelineHour,
  DeliveryMetrics,
  DeliveryStats,
  DeliveryTaskRow,
  GithubRateLimit,
  PromptBudgetRecord,
} from "$lib/types";
import { STOREFRONT, API, NOW, HOUR, DAY } from "./seed-constants";

/** The seeded session behind a usage row.
 *
 *  Throws rather than skipping: a usage row naming a session the herd does not have is a
 *  seed bug, and silently dropping it is how the fixture drifted out of agreement in the
 *  first place. `buildSeed()` runs under every demo test, so this fails in CI, loudly. */
function session(sessions: Session[], sessionId: string): Session {
  const found = sessions.find((s) => s.id === sessionId);
  if (!found) throw new Error(`demo seed: usage fixture references unknown session "${sessionId}"`);
  return found;
}

/** Display basename of a repo path — the `repo` field the delivery rows and breakdown
 *  headers render. Derived, so it cannot disagree with the session's own `repoPath`. */
const repoName = (repoPath: string): string => repoPath.split("/").pop() ?? repoPath;

/** The demo's one weighted-unit → token conversion. `task()` already splits a row's token
 *  detail off `authoringUnits` at this rate; the models block below folds the same rate, so
 *  the two sides of the breakdown are expressed in ONE unit rather than two that look alike. */
const TOKENS_PER_UNIT = 1000;

/** The satellite (non-coding) passes in range: which role ran, on what model, for how many
 *  weighted units, across how many passes.
 *
 *  ONE source for both sides of the same fact — `satelliteByKind` feeds the Overhead lens,
 *  and the per-role token entries feed the Models lens, which folds them into `byModel`.
 *  Two literals would let the two lenses disagree about the same passes. */
const SATELLITE: ReadonlyArray<{ role: UsageRole; model: string; units: number; count: number }> = [
  { role: "review", model: "sonnet", units: 470, count: 14 },
  { role: "plan_gate", model: "sonnet", units: 240, count: 9 },
  { role: "recap", model: "sonnet", units: 110, count: 6 },
  { role: "classifier", model: "sonnet", units: 55, count: 41 },
  { role: "maintain", model: "sonnet", units: 35, count: 2 },
];

/** Sum a role→model→tokens map down to model→tokens, exactly as `foldModels` does in
 *  `src/usage-breakdown.ts`. EVERY role folds in, not just coding: `ModelsLens` prints the
 *  provider header from `totalTokens` and each role's share as `tokens / totalTokens`, so a
 *  `byModel` missing the satellite roles renders a header that disagrees with its own model
 *  list and role shares that round to 0.0%. */
function foldModels(byRole: UsageByRole): Record<string, number> {
  const byModel: Record<string, number> = {};
  for (const models of Object.values(byRole)) {
    for (const [model, tokens] of Object.entries(models ?? {})) {
      byModel[model] = (byModel[model] ?? 0) + tokens;
    }
  }
  return byModel;
}

/** One task row of a repo's breakdown: identity from the session, numbers from here.
 *
 *  `tokens` is the raw authoring detail behind `authoringUnits`; the cacheRead-heavy
 *  split is what real Claude Code usage looks like (see the token-usage analysis in
 *  #496 — cacheRead dominates), so an even split would misrepresent where spend goes. */
function task(
  sessions: Session[],
  sessionId: string,
  authoringUnits: number,
  satelliteUnits: number,
): UsageTaskBreakdown {
  const s = session(sessions, sessionId);
  const model = s.model ?? "opus";
  const total = authoringUnits * 1000;
  return {
    sessionId: s.id,
    desig: s.desig,
    name: s.name,
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
export function buildUsageBreakdown(sessions: Session[]): UsageBreakdown {
  const storefrontTasks = [
    task(sessions, "coupon", 980, 120),
    task(sessions, "rounding", 610, 190),
    task(sessions, "ogimg", 540, 150),
    task(sessions, "deps", 470, 130),
    task(sessions, "envflag", 380, 100),
  ];
  const apiTasks = [task(sessions, "authstore", 530, 140), task(sessions, "neon", 400, 80)];
  const sum = (rows: UsageTaskBreakdown[], key: "authoringUnits" | "satelliteUnits") =>
    rows.reduce((n, r) => n + r[key], 0);

  // Repo and global totals are SUMMED from the task rows rather than stated separately —
  // the Spend lens renders a repo's share against the total, so a hand-written total that
  // drifted from its own rows would render a bar that disagrees with the list under it.
  const authoringUnits = sum(storefrontTasks, "authoringUnits") + sum(apiTasks, "authoringUnits");
  const satelliteUnits = sum(storefrontTasks, "satelliteUnits") + sum(apiTasks, "satelliteUnits");
  // Role → model → TOKENS, the shape `claudeUsageByRole` produces server-side. `coding` is
  // the authoring side of the task rows above; the rest are the satellite passes.
  const byRole: UsageByRole = {
    coding: [...storefrontTasks, ...apiTasks].reduce<Record<string, number>>((acc, r) => {
      acc[r.model] = (acc[r.model] ?? 0) + r.authoringUnits * TOKENS_PER_UNIT;
      return acc;
    }, {}),
    ...Object.fromEntries(
      SATELLITE.map((sp) => [sp.role, { [sp.model]: sp.units * TOKENS_PER_UNIT }]),
    ),
  };
  // The two invariants the real builder holds (src/usage-breakdown.ts): `byModel` is every
  // role folded together, and `totalTokens` is the sum of `byModel`.
  const byModel = foldModels(byRole);
  const totalTokens = Object.values(byModel).reduce((n, tokens) => n + tokens, 0);

  return {
    range: "7d",
    generatedAt: NOW,
    totalUnits: authoringUnits + satelliteUnits,
    authoringUnits,
    satelliteUnits,
    cacheReadUnits: Math.round(authoringUnits * 0.83),
    generationUnits: Math.round(authoringUnits * 0.17),
    satelliteByKind: SATELLITE.map((sp) => ({
      kind: sp.role,
      units: sp.units,
      count: sp.count,
    })),
    dollars: null,
    models: {
      claude: { totalTokens, byModel, byRole },
      // Every seeded session runs on Claude (see `mkSession`'s default), so the codex side
      // is a true zero rather than an invented second provider — and 0 is the sum of `{}`,
      // so it holds the same two invariants.
      codex: { totalTokens: 0, byModel: {}, byRole: {} },
    },
    repos: [
      {
        repoPath: STOREFRONT,
        repoName: repoName(STOREFRONT),
        authoringUnits: sum(storefrontTasks, "authoringUnits"),
        satelliteUnits: sum(storefrontTasks, "satelliteUnits"),
        dollars: null,
        tasks: storefrontTasks,
      },
      {
        repoPath: API,
        repoName: repoName(API),
        authoringUnits: sum(apiTasks, "authoringUnits"),
        satelliteUnits: sum(apiTasks, "satelliteUnits"),
        dollars: null,
        tasks: apiTasks,
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
  return {
    range: "24h",
    generatedAt: NOW,
    hours,
    totalUnits: hours.reduce((sum, h) => sum + h.units, 0),
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

/** One merged-task row: identity and PR number from the herd, cycle numbers from here.
 *  `prNumber` is whatever `gitStates` records for the session — null for an archived
 *  session the demo keeps no git state for, which is exactly what the real server reports
 *  once a session's PR record is gone. */
function deliveryTask(
  sessions: Session[],
  gitStates: Record<string, GitState>,
  sessionId: string,
  numbers: {
    reviewRounds: number;
    planRounds: number;
    firstPass: boolean | null;
    timeToFirstReviewMs: number | null;
    leadTimeMs: number | null;
    mergedAt: number;
  },
): DeliveryTaskRow {
  const s = session(sessions, sessionId);
  return {
    sessionId: s.id,
    desig: s.desig,
    repo: repoName(s.repoPath),
    issueNumber: s.issueNumber ?? null,
    prNumber: gitStates[s.id]?.number ?? null,
    ...numbers,
  };
}

/** GET /api/usage/delivery?range= — the Delivery lens. Totals are the two repo rows
 *  summed where summing is meaningful (counts) and re-derived where it is not
 *  (rates/medians are over the pooled sample, not an average of averages). */
export function buildDeliveryMetrics(
  sessions: Session[],
  gitStates: Record<string, GitState>,
): DeliveryMetrics {
  const sf = storefrontStats();
  const api = apiStats();
  return {
    range: "7d",
    generatedAt: NOW,
    since: NOW - 7 * DAY,
    measuringSince: NOW - 23 * DAY,
    totals: {
      mergedTasks: sf.mergedTasks + api.mergedTasks,
      firstPassRate: sample(0.58, 19),
      unreviewed: sf.unreviewed + api.unreviewed,
      reworkCyclesMedian: sample(1, 18),
      reworkCyclesMean: sample(1.5, 18),
      criticErrors: sf.criticErrors + api.criticErrors,
      planRoundsMedian: sample(1, 11),
      planReworkRate: sample(0.27, 11),
      planDriftRate: sample(0.12, 8),
      planDriftMajor: 0,
      timeToFirstReviewMs: sample(13 * 60_000, 18),
      leadTimeMs: sample(3.7 * HOUR, 19),
      firstPushGreenRate: sample(0.71, 14),
    },
    repos: [
      { ...sf, repoPath: STOREFRONT, repo: repoName(STOREFRONT) },
      { ...api, repoPath: API, repo: repoName(API) },
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
    // Newest-merged first, and every row is a session the herd actually shows as merged
    // or archived — so a visitor can follow any row back to the card it came from.
    tasks: [
      deliveryTask(sessions, gitStates, "deps", {
        reviewRounds: 1,
        planRounds: 0,
        firstPass: true,
        timeToFirstReviewMs: 9 * 60_000,
        leadTimeMs: 2.4 * HOUR,
        mergedAt: NOW - 4 * HOUR,
      }),
      deliveryTask(sessions, gitStates, "envflag", {
        reviewRounds: 2,
        planRounds: 1,
        firstPass: false,
        timeToFirstReviewMs: 14 * 60_000,
        leadTimeMs: 6.1 * HOUR,
        mergedAt: NOW - 7 * HOUR,
      }),
      deliveryTask(sessions, gitStates, "navpills", {
        reviewRounds: 1,
        planRounds: 1,
        firstPass: true,
        timeToFirstReviewMs: 8 * 60_000,
        leadTimeMs: 3.9 * HOUR,
        mergedAt: NOW - 5 * HOUR,
      }),
      deliveryTask(sessions, gitStates, "ratelimit", {
        reviewRounds: 3,
        planRounds: 1,
        firstPass: false,
        timeToFirstReviewMs: 22 * 60_000,
        leadTimeMs: 7.8 * HOUR,
        mergedAt: NOW - 20 * HOUR,
      }),
    ],
  };
}

/** GET /api/prompt-budget — the Prompt tab's per-spawn assembled-directive breakdown.
 *
 *  One attended spawn and one unattended (drain) spawn, so the tab shows both `auto`
 *  states. Both are `append-system-prompt`: that is a function of the provider (Claude
 *  takes the payload on the flag; Codex has none and must inline it), and every seeded
 *  session runs on Claude — so a second `delivery` mode here would be inventing a
 *  provider the herd does not have. */
export function buildPromptBudgets(sessions: Session[]): PromptBudgetRecord[] {
  const record = (
    sessionId: string,
    blocks: PromptBudgetRecord["blocks"],
    createdAt: number,
  ): PromptBudgetRecord => {
    const s = session(sessions, sessionId);
    // `Session.agentProvider` is optional; the server's own default is claude, and
    // `mkSession` seeds it explicitly — so this fallback never fires for a seeded row.
    const agentProvider = s.agentProvider ?? "claude";
    const totalChars = blocks.reduce((n, b) => n + b.chars, 0);
    return {
      sessionId: s.id,
      desig: s.desig,
      repoPath: s.repoPath,
      agentProvider,
      auto: s.auto === true,
      delivery: agentProvider === "codex" ? "inline-prompt" : "append-system-prompt",
      // Summed from the blocks, not stated: the lens renders each block's share OF this
      // total, so a hand-written total would render shares that do not reach 100%.
      totalChars,
      totalBytes: blocks.reduce((n, b) => n + b.bytes, 0),
      totalTokens: blocks.reduce((n, b) => n + b.tokens, 0),
      blocks,
      createdAt,
    };
  };
  return [
    record(
      "coupon",
      [
        { name: "house-rules", chars: 6100, bytes: 6180, tokens: 1560 },
        { name: "learnings", chars: 4830, bytes: 4900, tokens: 1240 },
        { name: "task", chars: 3910, bytes: 3960, tokens: 1000 },
        { name: "repo-context", chars: 2400, bytes: 2430, tokens: 610 },
        { name: "conventions", chars: 1180, bytes: 1180, tokens: 310 },
      ],
      NOW - 55 * 60_000,
    ),
    record(
      "checkout-child",
      [
        { name: "house-rules", chars: 6100, bytes: 6180, tokens: 1560 },
        { name: "task", chars: 3560, bytes: 3600, tokens: 910 },
        { name: "repo-context", chars: 2400, bytes: 2400, tokens: 620 },
      ],
      NOW - 21 * 60_000,
    ),
  ];
}
