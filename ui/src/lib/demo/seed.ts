// Pure seed data for the demo world. `buildSeed()` returns a fresh, deep-cloneable
// object graph — no timers, no bus, no imports from state/router/director. Every
// record is typed against `$lib/types`, so `tsc` proves each shape matches what the
// live UI consumes.
//
// The scenario — the fictional herd the marketing demo shows off:
//   Two repos: `acme/storefront` (SvelteKit storefront) + `acme/api` (bun API).
//   One active epic "Checkout v2" on storefront, mid-drain.
//   Eight sessions spanning states so every lens / badge / panel has a real subject:
//     coupon         WORKING (hero)   live activity, subagents, growing diff, no PR yet
//     rounding       READY            PR open, CI green, ready-to-merge
//     authstore      PLAN GATE        plan-gate verdict awaiting the operator's Go
//     neon           BLOCKED          autopilot question awaiting an answer
//     ogimg          MERGING          in the merge train
//     deps           DONE             recap + merged PR + one owed (post-merge) manual step
//     envflag        DONE             merged PR + one un-acked PRE-merge step (#1478 showcase)
//     checkout-child WORKING (auto)   epic child, drain-spawned
// Session ids are STABLE + semantic — replay transcripts (Task 5) and the director
// (Task 6) key off them.

import type {
  Session,
  GitState,
  SessionActivity,
  SubagentEntry,
  HoldReason,
  Epic,
  CompletedEpic,
  DrainStatus,
  AutoMergeStatus,
  BuildQueue,
  Recap,
  ReviewVerdict,
  PlanGate,
  HerdDigest,
  UpNextSnapshot,
  UpNextItem,
  BacklogPayload,
  Settings,
  PluginInfo,
  DiagnosticsSnapshot,
  HeldTask,
  Steer,
  ProjectIcons,
  Learning,
  UsageLimitsResponse,
  UpdateStatus,
  HerdrUpdateStatus,
  CodexUpdateStatus,
  StarPromptStatus,
  ActivityEntry,
  DiffResult,
  ScratchListing,
  SessionUsage,
  SlashCommand,
  PostMergeSteps,
} from "$lib/types";
import type { DemoWorld, DemoRepoConfig } from "./types-world";

const STOREFRONT = "/demo/acme/storefront";
const API = "/demo/acme/api";
const EPIC_PARENT = 100;

// A fixed clock anchor so the seed is deterministic (Task 6's director advances live
// timestamps at runtime). Offsets below are relative to this — never `Date.now()`.
const NOW = Date.UTC(2026, 5, 30, 12, 0, 0);
const SEC = 1_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Fill a full Session from a partial, defaulting every required field. */
function mkSession(
  partial: Partial<Session> & Pick<Session, "id" | "desig" | "name" | "repoPath">,
): Session {
  return {
    prompt: "",
    baseBranch: "main",
    branch: `shepherd/${partial.name}`,
    worktreePath: `${partial.repoPath}/.worktrees/${partial.id}`,
    isolated: true,
    herdrSession: `herdr-${partial.id}`,
    herdrAgentId: `agent-${partial.id}`,
    claudeSessionId: `claude-${partial.id}`,
    agentProvider: "claude",
    model: "opus",
    status: "running",
    readyToMerge: false,
    mergingSince: null,
    mergingTrainId: null,
    mergeTrainPrs: null,
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
    sandboxApplied: "standard",
    sandboxDegraded: false,
    research: false,
    epicAuthoring: false,
    egressApplied: false,
    egressDegraded: false,
    issueNumber: null,
    lastState: "running",
    createdAt: NOW - 2 * HOUR,
    updatedAt: NOW - 5 * MIN,
    archivedAt: null,
    haltReason: null,
    haltedAt: null,
    manualSteps: [],
    manualStepsAckedAt: null,
    experimentId: null,
    experimentRole: null,
    hasScratchpadFiles: false,
    ...partial,
  };
}

const NEON_QUESTION =
  "The Neon branch starts empty — should I seed it from the current Postgres dump, or start clean and let migrations rebuild it?";

function buildSessions(): Session[] {
  return [
    // ── hero: live-working coupon field, growing diff, subagents, no PR yet ──
    mkSession({
      id: "coupon",
      desig: "TASK-41",
      name: "coupon-code-field",
      repoPath: STOREFRONT,
      branch: "shepherd/coupon-code-field",
      prompt: "Add a coupon-code field to the checkout summary and apply the discount",
      model: "opus",
      status: "running",
      autopilotEnabled: null,
      issueNumber: 101,
      lastState: "working",
      createdAt: NOW - 55 * MIN,
      updatedAt: NOW - 20 * SEC,
      hasScratchpadFiles: true,
    }),
    // ── ready: PR open, CI green, awaiting merge ────────────────────────────
    mkSession({
      id: "rounding",
      desig: "TASK-38",
      name: "fix-cart-rounding",
      repoPath: STOREFRONT,
      branch: "shepherd/fix-cart-rounding",
      prompt: "Fix the cart-total rounding bug that drops a cent on 3-for-2 offers",
      model: "sonnet",
      status: "idle",
      readyToMerge: true,
      issueNumber: 103,
      lastState: "idle",
      createdAt: NOW - 3 * HOUR,
      updatedAt: NOW - 25 * MIN,
    }),
    // ── plan gate: verdict approved, awaiting the operator's Go ──────────────
    mkSession({
      id: "authstore",
      desig: "TASK-44",
      name: "auth-session-store",
      repoPath: API,
      branch: "shepherd/auth-session-store",
      prompt: "Rework the auth session store to a rotating refresh-token scheme",
      model: "opus",
      status: "blocked",
      planGateEnabled: true,
      planPhase: "planning",
      issueNumber: 220,
      lastState: "blocked",
      createdAt: NOW - 40 * MIN,
      updatedAt: NOW - 8 * MIN,
    }),
    // ── blocked: autopilot paused on a hand-back question ───────────────────
    mkSession({
      id: "neon",
      desig: "TASK-45",
      name: "neon-postgres",
      repoPath: API,
      branch: "shepherd/neon-postgres",
      prompt: "Migrate the API's database layer to Neon serverless Postgres",
      model: "opus",
      status: "blocked",
      autopilotEnabled: true,
      autopilotStepCount: 6,
      autopilotPaused: true,
      autopilotQuestion: NEON_QUESTION,
      issueNumber: 221,
      lastState: "blocked",
      createdAt: NOW - 70 * MIN,
      updatedAt: NOW - 4 * MIN,
    }),
    // ── merging: PR selected into the merge train ───────────────────────────
    mkSession({
      id: "ogimg",
      desig: "TASK-39",
      name: "og-images",
      repoPath: STOREFRONT,
      branch: "shepherd/og-images",
      prompt: "Generate dynamic OG images for product pages",
      model: "sonnet",
      status: "running",
      readyToMerge: true,
      mergingSince: NOW - 90 * SEC,
      mergingTrainId: "ogimg",
      mergeTrainPrs: [508],
      autoMergeEnabled: true,
      issueNumber: 140,
      lastState: "merging",
      createdAt: NOW - 5 * HOUR,
      updatedAt: NOW - 90 * SEC,
    }),
    // ── done: merged, recap present, one owed post-merge manual step ────────
    mkSession({
      id: "deps",
      desig: "TASK-37",
      name: "bump-deps",
      repoPath: STOREFRONT,
      branch: "shepherd/bump-deps",
      prompt: "Bump dependencies to latest and fix the resulting lint errors",
      model: "sonnet",
      status: "done",
      issueNumber: 137,
      lastState: "done",
      createdAt: NOW - 6 * HOUR,
      updatedAt: NOW - 45 * MIN,
      manualSteps: [
        {
          id: "deps-ms-1",
          text: "Rotate the CI dependency-cache key so the runners pick up the new lockfile",
          postMerge: true,
        },
      ],
      manualStepsAckedAt: null,
    }),
    // ── done: merged, but an un-acked PRE-merge manual step slipped through — the
    // merged-card "Resolve N step(s)" showcase (#1478). Unlike deps' post-merge step,
    // this one is `postMerge: false`, so `hasBlockingManualSteps` in UnitRow is true
    // right up until Ack/Resolve — but the terminal (merged) card hides the moot Ack
    // CTA and verb-labels the chip instead, routing to the matching Owed record below.
    mkSession({
      id: "envflag",
      desig: "TASK-50",
      name: "feature-x-rollout",
      repoPath: STOREFRONT,
      branch: "shepherd/feature-x-rollout",
      prompt: "Roll out the new checkout speed test behind a FEATURE_X flag",
      model: "sonnet",
      status: "done",
      issueNumber: 150,
      lastState: "done",
      createdAt: NOW - 8 * HOUR,
      updatedAt: NOW - 70 * MIN,
      manualSteps: [
        {
          id: "envflag-ms-1",
          text: "Set the FEATURE_X env var in production",
          postMerge: false,
        },
      ],
      manualStepsAckedAt: null,
    }),
    // ── working (autopilot): epic child spawned by the drain ────────────────
    mkSession({
      id: "checkout-child",
      desig: "TASK-42",
      name: "shipping-estimator",
      repoPath: STOREFRONT,
      branch: "shepherd/shipping-estimator",
      prompt: "Add a shipping-cost estimator to the checkout summary",
      model: "opus",
      status: "running",
      autopilotEnabled: true,
      autopilotStepCount: 2,
      auto: true,
      issueNumber: 102,
      lastState: "working",
      createdAt: NOW - 18 * MIN,
      updatedAt: NOW - 40 * SEC,
      hasScratchpadFiles: true,
    }),
  ];
}

const gh = (repo: string) => repo.replace("/demo/", "https://github.com/");

// ── Done lens (#Task 8): sessions ARCHIVED before this boot, distinct from the live
// `sessions` list above. `deps` (TASK-37) is deliberately NOT duplicated here — it's
// still live (done + one owed manual step), not yet archived, so it belongs only in
// the main herd / Owed lens. These three are already-closed-out work so the Done lens
// (and its recap-per-row) has real, varied content the moment it's opened.
function buildDoneSessions(): Session[] {
  return [
    mkSession({
      id: "navpills",
      desig: "TASK-33",
      name: "nav-active-pills",
      repoPath: STOREFRONT,
      branch: "shepherd/nav-active-pills",
      prompt: "Add active-state pills to the category navigation",
      model: "sonnet",
      status: "archived",
      lastState: "archived",
      readyToMerge: true,
      issueNumber: 130,
      issueUrl: `${gh(STOREFRONT)}/issues/130`,
      createdAt: NOW - 9 * HOUR,
      updatedAt: NOW - 5 * HOUR,
      archivedAt: NOW - 5 * HOUR,
    }),
    mkSession({
      id: "ratelimit",
      desig: "TASK-28",
      name: "api-rate-limit",
      repoPath: API,
      branch: "shepherd/api-rate-limit",
      prompt: "Add per-IP rate limiting to the public API",
      model: "opus",
      status: "archived",
      lastState: "archived",
      readyToMerge: true,
      issueNumber: 210,
      issueUrl: `${gh(API)}/issues/210`,
      createdAt: NOW - 26 * HOUR,
      updatedAt: NOW - 20 * HOUR,
      archivedAt: NOW - 20 * HOUR,
      manualSteps: [
        {
          id: "ratelimit-ms-1",
          text: "Document the new 429 response shape in the API README",
          postMerge: true,
        },
      ],
      manualStepsAckedAt: NOW - 19 * HOUR,
    }),
    mkSession({
      id: "imgopt",
      desig: "TASK-30",
      name: "responsive-product-images",
      repoPath: STOREFRONT,
      branch: "shepherd/responsive-product-images",
      prompt: "Serve responsive srcset images on product cards",
      model: "sonnet",
      status: "archived",
      lastState: "archived",
      readyToMerge: true,
      issueNumber: 132,
      issueUrl: `${gh(STOREFRONT)}/issues/132`,
      createdAt: NOW - 33 * HOUR,
      updatedAt: NOW - 30 * HOUR,
      archivedAt: NOW - 30 * HOUR,
    }),
  ];
}

function buildGitStates(): Record<string, GitState> {
  return {
    // hero — still building; no PR yet.
    coupon: { kind: "github", state: "none", checks: "none", deployConfigured: true },
    // ready to merge — open, green, clean.
    rounding: {
      kind: "github",
      state: "open",
      number: 512,
      url: `${gh(STOREFRONT)}/pull/512`,
      title: "TASK-38: fix cart-total rounding on 3-for-2 offers",
      createdAt: NOW - 35 * MIN,
      mergeable: true,
      checks: "success",
      mergeStateStatus: "clean",
      deployConfigured: true,
      headSha: "a1b2c3d",
      issueUrl: `${gh(STOREFRONT)}/issues/103`,
    },
    // plan gate — no code yet.
    authstore: { kind: "github", state: "none", checks: "none", deployConfigured: false },
    // blocked on a question — no PR yet.
    neon: { kind: "github", state: "none", checks: "none", deployConfigured: false },
    // in the merge train — open, green, being landed now.
    ogimg: {
      kind: "github",
      state: "open",
      number: 508,
      url: `${gh(STOREFRONT)}/pull/508`,
      title: "TASK-39: dynamic OG images for product pages",
      createdAt: NOW - 2 * HOUR,
      mergeable: true,
      checks: "success",
      mergeStateStatus: "clean",
      deployConfigured: true,
      headSha: "e4f5a6b",
      issueUrl: `${gh(STOREFRONT)}/issues/140`,
    },
    // done — PR merged.
    deps: {
      kind: "github",
      state: "merged",
      number: 505,
      url: `${gh(STOREFRONT)}/pull/505`,
      title: "TASK-37: bump dependencies + fix lint",
      createdAt: NOW - 5 * HOUR,
      mergeable: true,
      checks: "success",
      mergeStateStatus: "clean",
      deployConfigured: true,
      headSha: "c7d8e9f",
      issueUrl: `${gh(STOREFRONT)}/issues/137`,
    },
    // done — merged, but a pre-merge manual step is still un-acked (#1478 showcase).
    envflag: {
      kind: "github",
      state: "merged",
      number: 520,
      url: `${gh(STOREFRONT)}/pull/520`,
      title: "TASK-50: roll out feature X behind env flag",
      createdAt: NOW - 8 * HOUR,
      mergeable: true,
      checks: "success",
      mergeStateStatus: "clean",
      deployConfigured: true,
      headSha: "f1a2b3c",
      issueUrl: `${gh(STOREFRONT)}/issues/150`,
    },
    // epic child — building; no PR yet.
    "checkout-child": { kind: "github", state: "none", checks: "none", deployConfigured: true },
  };
}

function buildActivityStates(): Record<string, SessionActivity> {
  return {
    coupon: {
      lastActivityTs: NOW - 20 * SEC,
      summary: "edited src/routes/checkout/CouponField.svelte",
      recentTs: [NOW - 6 * MIN, NOW - 4 * MIN, NOW - 2 * MIN, NOW - 50 * SEC, NOW - 20 * SEC],
      recentErrTs: [NOW - 4 * MIN],
    },
    "checkout-child": {
      lastActivityTs: NOW - 40 * SEC,
      summary: "$ bun run check",
      recentTs: [NOW - 3 * MIN, NOW - 90 * SEC, NOW - 40 * SEC],
      recentErrTs: [],
    },
    rounding: {
      lastActivityTs: NOW - 25 * MIN,
      summary: "$ bun test src/lib/cart",
      recentTs: [NOW - 32 * MIN, NOW - 28 * MIN, NOW - 25 * MIN],
      recentErrTs: [],
    },
    ogimg: {
      lastActivityTs: NOW - 90 * SEC,
      summary: "pushed shepherd/og-images",
      recentTs: [NOW - 6 * MIN, NOW - 3 * MIN, NOW - 90 * SEC],
      recentErrTs: [],
    },
    neon: {
      lastActivityTs: NOW - 4 * MIN,
      summary: "asked: seed from dump or start clean?",
      recentTs: [NOW - 12 * MIN, NOW - 7 * MIN, NOW - 4 * MIN],
      recentErrTs: [],
    },
    authstore: {
      lastActivityTs: NOW - 8 * MIN,
      summary: "drafted refresh-token rotation plan",
      recentTs: [NOW - 20 * MIN, NOW - 12 * MIN, NOW - 8 * MIN],
      recentErrTs: [],
    },
    deps: {
      lastActivityTs: NOW - 45 * MIN,
      summary: "merged shepherd/bump-deps",
      recentTs: [NOW - 55 * MIN, NOW - 48 * MIN, NOW - 45 * MIN],
      recentErrTs: [],
    },
  };
}

function buildSubagentStates(): Record<string, SubagentEntry[]> {
  return {
    coupon: [
      {
        agentId: "sub-coupon-explore",
        agentType: "Explore",
        startedAt: NOW - 10 * MIN,
        endedAt: NOW - 7 * MIN,
      },
      {
        agentId: "sub-coupon-pricing",
        agentType: "general-purpose",
        startedAt: NOW - 5 * MIN,
        endedAt: NOW - 2 * MIN,
      },
      { agentId: "sub-coupon-ui", agentType: "general-purpose", startedAt: NOW - 90 * SEC },
    ],
    "checkout-child": [
      { agentId: "sub-child-explore", agentType: "Explore", startedAt: NOW - 6 * MIN },
    ],
  };
}

function buildUsage(): UsageLimitsResponse {
  return {
    limits: {
      session5h: { pct: 68, resetAt: NOW + 2 * HOUR },
      week: { pct: 74, resetAt: NOW + 3 * DAY },
      perModelWeek: [],
      credits: null,
      stale: false,
      calibratedAt: NOW - 8 * MIN,
      subscriptionOnly: false,
    },
    projections: [
      { window: "5H", projectedPct: 82, resetAt: NOW + 2 * HOUR, burnRatePerHour: 14 },
      { window: "WK", projectedPct: 79, resetAt: NOW + 3 * DAY, burnRatePerHour: 6 },
    ],
  };
}

function buildEpics(): Epic[] {
  const issue = (n: number) => `${gh(STOREFRONT)}/issues/${n}`;
  return [
    {
      repoPath: STOREFRONT,
      parentIssueNumber: EPIC_PARENT,
      parentTitle: "Checkout v2",
      source: "native",
      warnings: [],
      run: {
        repoPath: STOREFRONT,
        parentIssueNumber: EPIC_PARENT,
        mode: "attended",
        status: "running",
      },
      children: [
        {
          number: 101,
          title: "Coupon-code field at checkout",
          url: issue(101),
          order: 0,
          body: "Add a coupon-code field to the summary and apply the discount to the total.",
          blockedBy: [],
          state: "running",
          sessionId: "coupon",
          prNumber: null,
          issueClosed: false,
          claimed: true,
        },
        {
          number: 102,
          title: "Shipping-cost estimator",
          url: issue(102),
          order: 1,
          body: "Estimate shipping cost from the cart weight + destination and show it in the summary.",
          blockedBy: [],
          state: "running",
          sessionId: "checkout-child",
          prNumber: null,
          issueClosed: false,
          claimed: true,
        },
        {
          number: 103,
          title: "Cart-total rounding fix",
          url: issue(103),
          order: 2,
          body: "Fix the rounding bug that drops a cent on 3-for-2 offers.",
          blockedBy: [],
          state: "in-review",
          sessionId: "rounding",
          prNumber: 512,
          issueClosed: false,
          claimed: true,
        },
        {
          number: 104,
          title: "Saved payment methods",
          url: issue(104),
          order: 3,
          body: "Let returning customers pick a stored card at checkout.",
          blockedBy: [101],
          state: "blocked",
          sessionId: null,
          prNumber: null,
          issueClosed: false,
          claimed: false,
        },
        {
          number: 105,
          title: "Guest checkout",
          url: issue(105),
          order: 4,
          body: "Allow checkout without an account, upgrading to one on confirmation.",
          blockedBy: [101, 102],
          state: "blocked",
          sessionId: null,
          prNumber: null,
          issueClosed: false,
          claimed: false,
        },
      ],
    },
  ];
}

function buildCompletedEpics(): CompletedEpic[] {
  return [
    {
      repoPath: STOREFRONT,
      parentIssueNumber: 88,
      parentTitle: "Cart refactor",
      completedAt: NOW - 2 * DAY,
      children: [
        {
          number: 81,
          title: "Cart store rewrite",
          url: `${gh(STOREFRONT)}/issues/81`,
          prNumber: 390,
          prUrl: `${gh(STOREFRONT)}/pull/390`,
          mergedAt: NOW - 2 * DAY - 2 * HOUR,
          integrated: true,
        },
        {
          number: 82,
          title: "Cart persistence to localStorage",
          url: `${gh(STOREFRONT)}/issues/82`,
          prNumber: 392,
          prUrl: `${gh(STOREFRONT)}/pull/392`,
          mergedAt: NOW - 2 * DAY,
          integrated: true,
        },
      ],
      landingPrNumber: 395,
      landingPrUrl: `${gh(STOREFRONT)}/pull/395`,
      landingState: "merged",
      migrationPaths: [],
      migrationsAckedAt: null,
    },
    {
      repoPath: API,
      parentIssueNumber: 200,
      parentTitle: "Rate limiting",
      completedAt: NOW - 5 * DAY,
      children: [
        {
          number: 201,
          title: "Token-bucket middleware",
          url: `${gh(API)}/issues/201`,
          prNumber: 310,
          prUrl: `${gh(API)}/pull/310`,
          mergedAt: NOW - 5 * DAY,
          integrated: true,
        },
      ],
      landingPrNumber: 312,
      landingPrUrl: `${gh(API)}/pull/312`,
      landingState: "merged",
      migrationPaths: [],
      migrationsAckedAt: null,
    },
  ];
}

function buildRecaps(): Record<string, Recap> {
  return {
    rounding: {
      sessionId: "rounding",
      state: "ready",
      headSha: "a1b2c3d",
      verdict: "ready",
      headline: "Cart-total rounding fixed for multi-buy offers",
      body: "Switched the running total to integer cents and rounded once at the end. Added a regression test for the 3-for-2 case that previously dropped a cent.",
      openItems: [],
      changedFiles: ["src/lib/cart/total.ts", "src/lib/cart/total.test.ts"],
      spawnSessionId: "recap-rounding",
      cwd: `${STOREFRONT}/.worktrees/rounding`,
      model: "sonnet",
      spawnedAt: NOW - 27 * MIN,
      generatedAt: NOW - 25 * MIN,
      updatedAt: NOW - 25 * MIN,
    },
    deps: {
      sessionId: "deps",
      state: "ready",
      headSha: "c7d8e9f",
      verdict: "needs_attention",
      headline: "Dependencies bumped; one post-merge step is owed",
      body: "Upgraded 34 packages to latest, regenerated the lockfile, and fixed the lint errors the new rules surfaced. The CI cache key must be rotated so runners pick up the new lockfile.",
      openItems: ["Rotate the CI dependency-cache key (post-merge)"],
      changedFiles: ["package.json", "bun.lockb", "eslint.config.js"],
      spawnSessionId: "recap-deps",
      cwd: `${STOREFRONT}/.worktrees/deps`,
      model: "sonnet",
      spawnedAt: NOW - 47 * MIN,
      generatedAt: NOW - 45 * MIN,
      updatedAt: NOW - 45 * MIN,
    },
    // ── Done lens recaps — one per archived session in buildDoneSessions() ────────
    navpills: {
      sessionId: "navpills",
      state: "ready",
      headSha: "f1a2b3c",
      verdict: "ready",
      headline: "Category nav now shows an active-state pill",
      body: "Added a pill indicator that tracks the selected category via the route's active link state, with a subtle slide transition between categories. Covered by a component test for keyboard nav.",
      openItems: [],
      changedFiles: ["src/routes/(shop)/categories/CategoryNav.svelte", "src/lib/nav/active.ts"],
      spawnSessionId: "recap-navpills",
      cwd: `${STOREFRONT}/.worktrees/navpills`,
      model: "sonnet",
      spawnedAt: NOW - 5.5 * HOUR,
      generatedAt: NOW - 5 * HOUR,
      updatedAt: NOW - 5 * HOUR,
    },
    ratelimit: {
      sessionId: "ratelimit",
      state: "ready",
      headSha: "a4b5c6d",
      verdict: "needs_attention",
      headline: "Per-IP rate limiting shipped; docs still owed",
      body: "Added a token-bucket limiter in front of the public API routes (60 req/min per IP, 429 on trip) backed by the existing Redis instance. The new 429 response shape still needs a README callout for API consumers.",
      openItems: ["Document the new 429 response shape in the API README (post-merge)"],
      changedFiles: ["src/middleware/rateLimit.ts", "src/routes/api/index.ts"],
      spawnSessionId: "recap-ratelimit",
      cwd: `${API}/.worktrees/ratelimit`,
      model: "opus",
      spawnedAt: NOW - 20.5 * HOUR,
      generatedAt: NOW - 20 * HOUR,
      updatedAt: NOW - 20 * HOUR,
    },
    imgopt: {
      sessionId: "imgopt",
      state: "ready",
      headSha: "b7c8d9e",
      verdict: "ready",
      headline: "Product images now serve responsive srcset variants",
      body: "Product-card and PDP images now request a device-appropriate size via `srcset` + `sizes`, generated at build time from the existing asset pipeline. Verified against Lighthouse's LCP image-size audit.",
      openItems: [],
      changedFiles: ["src/lib/components/ProductImage.svelte", "src/lib/images/srcset.ts"],
      spawnSessionId: "recap-imgopt",
      cwd: `${STOREFRONT}/.worktrees/imgopt`,
      model: "sonnet",
      spawnedAt: NOW - 30.5 * HOUR,
      generatedAt: NOW - 30 * HOUR,
      updatedAt: NOW - 30 * HOUR,
    },
  };
}

function buildReviews(): Record<string, ReviewVerdict> {
  return {
    rounding: {
      sessionId: "rounding",
      headSha: "a1b2c3d",
      decision: "commented",
      summary: "Correct fix; one edge case worth a note.",
      body: "Moving to integer cents is the right call and the regression test covers the reported case. Consider a comment on why the final rounding happens once, so a future refactor doesn't reintroduce per-line rounding.",
      findings: ["Add a comment explaining the single final-rounding step"],
      addressRound: 0,
      addressCap: 3,
      finalRoundPending: false,
      finalRoundTimeoutMs: 120_000,
      url: `${gh(STOREFRONT)}/pull/512#review`,
      updatedAt: NOW - 22 * MIN,
    },
  };
}

function buildPlanGates(): Record<string, PlanGate> {
  return {
    authstore: {
      sessionId: "authstore",
      planHash: "authstore-plan-1",
      decision: "approved",
      summary: "Plan approved: rotating refresh tokens with a short-lived access token.",
      body: "The rotation scheme is sound. Store refresh tokens hashed, rotate on every use, and revoke the family on reuse detection. Keep the access-token TTL at 15 minutes.",
      findings: [],
      round: 1,
      cap: 3,
      approved: true,
      plan: "1. Add a refresh_tokens table (hashed, family id)\n2. Issue short-lived access + rotating refresh on login\n3. Rotate on refresh; revoke the family on reuse\n4. Migrate existing sessions on next login",
      updatedAt: NOW - 8 * MIN,
    },
  };
}

function buildHerdDigest(): HerdDigest {
  return {
    dayKey: "2026-06-30",
    state: "ready",
    overnight:
      "The Cart-refactor epic landed. Checkout v2 is mid-drain across three tasks, and the API is picking up an auth-store rework plus a Neon migration.",
    decisions: [{ label: "Approved the auth-session-store plan", sessionId: "authstore" }],
    ciRework: [],
    train: "OG-images PR #508 is in the merge train.",
    focusNext: [
      { label: "Answer the Neon seeding question", sessionId: "neon" },
      { label: "Merge the cart-rounding fix", sessionId: "rounding", pr: 512 },
    ],
    epicsToLand: [],
    attentionFingerprint: { neon: ["autopilot-paused"], authstore: ["plan-approved"] },
    spawnSessionId: "digest-1",
    cwd: STOREFRONT,
    model: "opus",
    spawnedAt: NOW - 6 * HOUR,
    generatedAt: NOW - 6 * HOUR,
    updatedAt: NOW - 6 * HOUR,
  };
}

function buildUpNext(): UpNextSnapshot {
  type Kind = UpNextItem["kind"];
  const sfItem = (number: number, title: string, body: string, kind: Kind): UpNextItem => ({
    repoPath: STOREFRONT,
    repoSlug: "acme/storefront",
    repoLabel: "acme/storefront",
    number,
    title,
    url: `${gh(STOREFRONT)}/issues/${number}`,
    kind,
    priority: false,
    createdAt: NOW - 26 * HOUR,
    issueRef: { number, url: `${gh(STOREFRONT)}/issues/${number}`, title, body },
  });
  const apiItem = (number: number, title: string, body: string, kind: Kind): UpNextItem => ({
    repoPath: API,
    repoSlug: "acme/api",
    repoLabel: "acme/api",
    number,
    title,
    url: `${gh(API)}/issues/${number}`,
    kind,
    priority: false,
    createdAt: NOW - 30 * HOUR,
    issueRef: { number, url: `${gh(API)}/issues/${number}`, title, body },
  });
  return {
    generatedAt: NOW - 15 * MIN,
    repoCount: 2,
    fallback: null,
    failedRepoCount: 0,
    sections: [
      {
        kind: "repo",
        repoPath: STOREFRONT,
        repoSlug: "acme/storefront",
        repoLabel: "acme/storefront",
        totalCount: 2,
        items: [
          sfItem(
            121,
            "Wishlist button on product cards",
            "Let shoppers save items to a wishlist from the grid.",
            "feature",
          ),
          sfItem(
            122,
            "Empty-cart illustration",
            "Show a friendly empty state when the cart has no items.",
            "feature",
          ),
        ],
      },
      {
        kind: "repo",
        repoPath: API,
        repoSlug: "acme/api",
        repoLabel: "acme/api",
        totalCount: 1,
        items: [
          apiItem(
            222,
            "Add request-id correlation header",
            "Thread a request id through logs for tracing.",
            "feature",
          ),
        ],
      },
    ],
  };
}

function buildBacklog(): BacklogPayload {
  return {
    pinnedPath: STOREFRONT,
    totals: { openIssues: 11, openPRs: 2 },
    projects: [
      {
        path: STOREFRONT,
        display: "acme/storefront",
        slug: "acme/storefront",
        kind: "github",
        lastUsedAt: NOW - 20 * SEC,
        recentAgentCount: 5,
        openIssues: 8,
        openPRs: 2,
        prKinds: { release: 0, dependabot: 0, regular: 2 },
        workflows: 3,
        ciStatus: "success",
        hidden: false,
      },
      {
        path: API,
        display: "acme/api",
        slug: "acme/api",
        kind: "github",
        lastUsedAt: NOW - 4 * MIN,
        recentAgentCount: 2,
        openIssues: 3,
        openPRs: 0,
        prKinds: { release: 0, dependabot: 0, regular: 0 },
        workflows: 2,
        ciStatus: "success",
        hidden: false,
      },
    ],
  };
}

function buildBuildQueues(): Record<string, BuildQueue> {
  return {
    coupon: {
      sessionId: "coupon",
      approved: true,
      approvalKind: "auto",
      steps: [
        {
          id: "coupon-1",
          title: "Add the coupon input to the summary",
          status: "done",
          position: 0,
        },
        {
          id: "coupon-2",
          title: "Wire coupon validation to the pricing API",
          status: "active",
          position: 1,
        },
        {
          id: "coupon-3",
          title: "Apply the discount to the total",
          status: "pending",
          position: 2,
        },
        { id: "coupon-4", title: "Add unit + component tests", status: "pending", position: 3 },
      ],
    },
    authstore: {
      sessionId: "authstore",
      approved: false,
      steps: [
        {
          id: "auth-1",
          title: "Add the refresh_tokens table + migration",
          status: "pending",
          position: 0,
        },
        {
          id: "auth-2",
          title: "Issue rotating refresh tokens on login",
          status: "pending",
          position: 1,
        },
        { id: "auth-3", title: "Revoke the token family on reuse", status: "pending", position: 2 },
      ],
    },
  };
}

function buildHeld(): HeldTask[] {
  return [
    {
      id: "held-refund-flow",
      repoPath: STOREFRONT,
      createdAt: NOW - 35 * MIN,
      input: {
        repoPath: STOREFRONT,
        baseBranch: "main",
        prompt: "Add a refund flow to the checkout admin panel",
        model: "opus",
      },
    },
    {
      id: "held-api-openapi",
      repoPath: API,
      createdAt: NOW - 22 * MIN,
      input: {
        repoPath: API,
        baseBranch: "main",
        prompt: "Generate an OpenAPI spec from the route handlers",
        model: "sonnet",
      },
    },
  ];
}

function buildSettings(): Settings {
  return {
    repoRoot: "/demo/acme",
    repoRootDisplay: "~/acme",
    // The hosted demo is a seeded, always-configured environment — never first-run.
    firstRunPending: false,
    remoteControlAtStartup: false,
    sessionHousekeepingEnabled: true,
    defaultModel: "auto",
    defaultEffort: "default",
    operatorLanguage: "en",
    criticCli: "inherit",
    criticModel: "default",
    criticEffort: "high",
    plannerCli: "inherit",
    plannerModel: "default",
    plannerEffort: "default",
    recapCli: "inherit",
    recapModel: "default",
    recapEffort: "low",
    docAgentCli: "inherit",
    docAgentModel: "default",
    docAgentEffort: "low",
    namerCli: "inherit",
    namerModel: "default",
    namerEffort: "low",
    autopilotCli: "inherit",
    autopilotModel: "default",
    autopilotEffort: "low",
    defaultAgentProvider: "claude",
    upnextSkipCliPicker: false,
    authMode: "subscription",
    hasApiKey: false,
    prReviewCyclesCap: 3,
    prReviewCyclesMin: 1,
    prReviewCyclesMax: 6,
    planReviewCyclesCap: 3,
    planReviewCyclesMin: 1,
    planReviewCyclesMax: 6,
    extraCreditsDrainCeiling: 0,
    sessionRetentionDays: 14,
    sessionRetentionKeep: 50,
    previewHost: null,
    usageHoldEnabled: true,
    usageHoldPct: 90,
    usageHoldAutoRelease: true,
    usageDowngradeEnabled: false,
    usageDowngradePct: 80,
    usageDowngradeModel: "auto",
    fableAvailable: true,
    tuiFullscreen: false,
    tuiDisableMouse: false,
    reducedPushMode: false,
    telemetryConsent: "unset",
    telemetryAvailable: true,
    docAgentEnabled: false,
    docAgentAct: false,
  };
}

function buildPlugins(): PluginInfo[] {
  return [
    {
      id: "demo-linear",
      name: "Linear sync",
      version: "1.2.0",
      health: "ok",
      lastError: null,
      status: {},
      ui: null,
      gearItem: null,
    },
    {
      id: "demo-slack",
      name: "Slack notifier",
      version: "0.7.1",
      health: "ok",
      lastError: null,
      status: {},
      ui: null,
      gearItem: null,
    },
  ];
}

function buildDiagnostics(): DiagnosticsSnapshot {
  return {
    generatedAt: NOW - HOUR,
    overall: "ok",
    checks: [
      { id: "git", state: "ok", hintKey: "diagnostics_hint_git_ok" },
      { id: "gh", state: "ok", hintKey: "diagnostics_hint_gh_ok" },
      { id: "node", state: "ok", hintKey: "diagnostics_hint_node_ok" },
      { id: "bun", state: "ok", hintKey: "diagnostics_hint_bun_ok" },
    ],
  };
}

function buildSteers(): Steer[] {
  return [
    {
      id: "steer-continue",
      label: "Continue",
      text: "Continue with the plan.",
      emoji: "▶️",
      inSteerBar: true,
      onIssues: false,
    },
    {
      id: "steer-tests",
      label: "Run tests",
      text: "Run the test suite and fix any failures.",
      emoji: "🧪",
      inSteerBar: true,
      onIssues: false,
    },
    {
      id: "steer-open-pr",
      label: "Open PR",
      text: "Open a pull request when the work is ready.",
      emoji: "🚀",
      inSteerBar: true,
      onIssues: false,
    },
  ];
}

function buildProjectIcons(): ProjectIcons {
  return { [STOREFRONT]: "🛒", [API]: "⚙️" };
}

function buildDrain(): DrainStatus[] {
  return [
    {
      repoPath: STOREFRONT,
      enabled: true,
      paused: false,
      reason: null,
      detail: null,
      queued: 2,
      inFlight: 2,
      max: 3,
      epicParent: EPIC_PARENT,
    },
    {
      repoPath: API,
      enabled: true,
      paused: false,
      reason: null,
      detail: null,
      queued: 1,
      inFlight: 2,
      max: 2,
      epicParent: null,
    },
  ];
}

function buildAutoMerge(): AutoMergeStatus[] {
  return [
    {
      repoPath: STOREFRONT,
      enabled: true,
      state: "merging",
      detail: "TASK-39",
      sessionId: "ogimg",
    },
    { repoPath: API, enabled: true, state: null, detail: null, sessionId: null },
  ];
}

function buildPendingLearnings(): Learning[] {
  return [
    {
      id: "learn-testid",
      repoPath: STOREFRONT,
      rule: "Add a stable data-testid to interactive checkout elements.",
      rationale: "Tests kept flaking on text-based selectors during the cart work.",
      evidence: ["rounding review flagged a fragile selector"],
      status: "proposed",
      evidenceCount: 2,
      ineffectiveCount: 0,
      helpfulCount: 0,
      injectedCount: 0,
      lastUsedAt: null,
      retiredAt: null,
      retiredReason: null,
      scopeGlobs: [],
      createdAt: NOW - 30 * MIN,
      updatedAt: NOW - 30 * MIN,
      lastEvidenceAt: NOW - 30 * MIN,
      promotedPrUrl: null,
    },
    {
      id: "learn-migrations",
      repoPath: API,
      rule: "Every schema change ships with a reversible migration.",
      rationale: "A forward-only change during the rate-limit epic blocked a rollback.",
      evidence: ["rate-limit epic needed a manual down-migration"],
      status: "proposed",
      evidenceCount: 1,
      ineffectiveCount: 0,
      helpfulCount: 0,
      injectedCount: 0,
      lastUsedAt: null,
      retiredAt: null,
      retiredReason: null,
      scopeGlobs: ["migrations/**"],
      createdAt: NOW - 3 * HOUR,
      updatedAt: NOW - 3 * HOUR,
      lastEvidenceAt: NOW - 3 * HOUR,
      promotedPrUrl: null,
    },
  ];
}

function buildUpdate(): UpdateStatus {
  return {
    behind: 0,
    current: "v0.42.0",
    latest: "v0.42.0",
    commits: [],
    checkedAt: NOW - 30 * MIN,
  };
}

function buildHerdrUpdate(): HerdrUpdateStatus {
  return {
    current: "0.9.3",
    latest: "0.9.3",
    updateAvailable: false,
    notes: null,
    checkedAt: NOW - 30 * MIN,
  };
}

function buildCodexUpdate(): CodexUpdateStatus {
  return {
    current: "0.30.0",
    latest: "0.30.0",
    updateAvailable: false,
    notes: null,
    checkedAt: NOW - 30 * MIN,
  };
}

function buildStarPrompt(): StarPromptStatus {
  return { shouldPrompt: false, starred: true };
}

function buildHolds(): Record<string, HoldReason> {
  return {
    // Autopilot paused, handing a question back to the operator.
    neon: { code: "autopilot-paused", params: { question: NEON_QUESTION } },
    // Done, but one post-merge manual step is still owed.
    deps: { code: "manual-steps", params: { steps: 1 } },
  };
}

// ── session-detail tabs (Task 8 sibling audit) ────────────────────────────────────
// Every GET a Viewport tab fires on open — Activity, Diff, Files, plus the always-on
// usage badge / build-queue panel / slash-command linkifier. Richly seeded for the
// hero (`coupon`) and its epic sibling (`checkout-child`); every OTHER live session
// still gets a valid (if empty) response so no tab can throw on a shape mismatch.

/** GET /api/sessions/:id/activity — only sessions actually doing visible work carry a
 *  transcript; a session with no seeded entry falls back to `[]` in state.ts (never `{}`). */
function buildActivityEntries(): Record<string, ActivityEntry[]> {
  return {
    coupon: [
      {
        ts: NOW - 6 * MIN,
        tool: "Read",
        summary: "src/routes/checkout/+page.svelte",
        status: "ok",
      },
      {
        ts: NOW - 5 * MIN,
        tool: "Edit",
        summary: "src/routes/checkout/CouponField.svelte",
        status: "ok",
      },
      { ts: NOW - 4 * MIN, tool: "Bash", summary: "bun run check", status: "error" },
      { ts: NOW - 3 * MIN, tool: "Edit", summary: "src/lib/cart/pricing.ts", status: "ok" },
      { ts: NOW - 2 * MIN, tool: "Bash", summary: "bun test src/lib/cart", status: "ok" },
      {
        ts: NOW - 50 * SEC,
        tool: "Edit",
        summary: "src/routes/checkout/CouponField.svelte",
        status: "ok",
      },
      { ts: NOW - 20 * SEC, tool: "Read", summary: "src/lib/cart/pricing.ts", status: "ok" },
    ],
    "checkout-child": [
      { ts: NOW - 6 * MIN, tool: "Read", summary: "src/lib/cart/totals.ts", status: "ok" },
      {
        ts: NOW - 90 * SEC,
        tool: "Edit",
        summary: "src/routes/checkout/ShippingEstimate.svelte",
        status: "ok",
      },
      { ts: NOW - 40 * SEC, tool: "Bash", summary: "bun run check", status: "ok" },
    ],
  };
}

/** GET /api/sessions/:id/diff — coupon's growing diff (hero, no PR yet) + a small one for
 *  its epic-child sibling. A session with no seeded entry falls back to a valid empty
 *  DiffResult in state.ts (base/head filled from the session, `files: []` — never `{}`). */
function buildDiffs(): Record<string, DiffResult> {
  return {
    coupon: {
      base: "main",
      baseRef: "origin/main",
      head: "shepherd/coupon-code-field",
      fetchFailed: false,
      truncated: false,
      files: [
        {
          path: "src/routes/checkout/CouponField.svelte",
          status: "added",
          additions: 42,
          deletions: 0,
          binary: false,
          hunks: [
            {
              header: "@@ -0,0 +1,12 @@",
              lines: [
                { kind: "add", content: '<script lang="ts">', newNo: 1 },
                {
                  kind: "add",
                  content: "  let { onapply }: { onapply: (code: string) => void } = $props();",
                  newNo: 2,
                },
                { kind: "add", content: '  let code = $state("");', newNo: 3 },
                { kind: "add", content: "</script>", newNo: 4 },
              ],
            },
          ],
        },
        {
          path: "src/lib/cart/pricing.ts",
          status: "modified",
          additions: 18,
          deletions: 4,
          binary: false,
          hunks: [
            {
              header: "@@ -20,8 +20,22 @@ export function computeTotal(",
              lines: [
                { kind: "ctx", content: "  let total = subtotal;", oldNo: 20, newNo: 20 },
                { kind: "del", content: "  return total;", oldNo: 21 },
                {
                  kind: "add",
                  content: "  if (coupon) total = applyCoupon(total, coupon);",
                  newNo: 21,
                },
                { kind: "add", content: "  return total;", newNo: 22 },
              ],
            },
          ],
        },
      ],
    },
    "checkout-child": {
      base: "main",
      baseRef: "origin/main",
      head: "shepherd/shipping-estimator",
      fetchFailed: false,
      truncated: false,
      files: [
        {
          path: "src/routes/checkout/ShippingEstimate.svelte",
          status: "added",
          additions: 26,
          deletions: 0,
          binary: false,
          hunks: [
            {
              header: "@@ -0,0 +1,8 @@",
              lines: [
                { kind: "add", content: '<script lang="ts">', newNo: 1 },
                {
                  kind: "add",
                  content: "  let { weightKg }: { weightKg: number } = $props();",
                  newNo: 2,
                },
                { kind: "add", content: "</script>", newNo: 3 },
              ],
            },
          ],
        },
      ],
    },
  };
}

/** GET /api/sessions/:id/scratchpad (root listing) — only sessions with
 *  `hasScratchpadFiles: true` carry seeded entries; everyone else gets the same synthetic
 *  empty listing the real server returns for a session with no scratchpad root yet. */
function buildScratchpad(): Record<string, ScratchListing> {
  return {
    coupon: {
      path: "",
      parent: null,
      entries: [
        { name: "notes.md", type: "file", path: "notes.md" },
        { name: "pricing-api-response.json", type: "file", path: "pricing-api-response.json" },
      ],
    },
    "checkout-child": {
      path: "",
      parent: null,
      entries: [{ name: "shipping-rates.json", type: "file", path: "shipping-rates.json" }],
    },
  };
}

/** GET /api/sessions/:id/usage — per-session token usage badge (polled while a session is
 *  open). Only the hero has meaningfully large numbers; everyone else is a valid zeroed
 *  record (`usage.total > 0` gates the badge, so a zero record renders nothing — safe, not empty-object). */
function buildSessionUsage(): Record<string, SessionUsage> {
  const zero: SessionUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    messageCount: 0,
    lastActivity: null,
    byModel: {},
  };
  return {
    coupon: {
      input: 42_000,
      output: 8_900,
      cacheRead: 120_000,
      cacheWrite: 15_000,
      total: 185_900,
      messageCount: 34,
      lastActivity: NOW - 20 * SEC,
      byModel: { opus: 185_900 },
    },
    "checkout-child": {
      input: 9_500,
      output: 2_100,
      cacheRead: 30_000,
      cacheWrite: 4_000,
      total: 45_600,
      messageCount: 11,
      lastActivity: NOW - 40 * SEC,
      byModel: { opus: 45_600 },
    },
    rounding: { ...zero },
    authstore: { ...zero },
    neon: { ...zero },
    ogimg: { ...zero },
    deps: { ...zero },
  };
}

/** GET /api/repo-config?repo= — automation flags per repo (gates the Build Queue panel +
 *  the GitRail automation pill). Both demo repos have automation configured + confirmed. */
function buildRepoConfig(): Record<string, DemoRepoConfig> {
  const base: DemoRepoConfig = {
    criticEnabled: true,
    criticAllPrs: false,
    autoAddressEnabled: false,
    learningsEnabled: true,
    autopilotEnabled: false,
    autoDrainEnabled: true,
    autoMergeEnabled: false,
    buildQueueEnabled: true,
    planGateEnabled: false,
    draftMode: false,
    signoffAuthority: "human",
    sandboxProfile: "trusted",
    defaultModel: "inherit",
    defaultEffort: "inherit",
    maxAuto: 1,
    autoLabel: "shepherd:auto",
    usageCeilingPct: 80,
    repoMode: "forge",
    autoOptimizeFlagged: false,
    manualStepsIssueEnabled: false,
    hidden: false,
    previewStartScript: null,
    previewStartCommand: null,
    previewOpenMode: "ask",
    automationConfirmed: true,
    automationRowExists: true,
  };
  return {
    [STOREFRONT]: { ...base, autoMergeEnabled: true, maxAuto: 3 },
    [API]: { ...base, autopilotEnabled: true, planGateEnabled: true, maxAuto: 2 },
  };
}

/** GET /api/commands?repo= — installed slash commands (terminal link provider). Same
 *  small, plausible set for both demo repos. */
function buildSlashCommands(): Record<string, SlashCommand[]> {
  const commands: SlashCommand[] = [
    { name: "test", description: "Run the test suite", scope: "project" },
    { name: "lint", description: "Run lint + typecheck", scope: "project" },
  ];
  return { [STOREFRONT]: commands, [API]: commands };
}

/** GET /api/todo?repo= — neither demo repo has a TODO.md, so the To-Do tab stays hidden;
 *  a real `{exists:false}` beats the permissive `{}` fallback (whose `.exists` is `undefined`,
 *  not `false`, and would leave the tab's visibility effect stuck unresolved). */
function buildTodo(): Record<string, { exists: boolean; content: string }> {
  return {
    [STOREFRONT]: { exists: false, content: "" },
    [API]: { exists: false, content: "" },
  };
}

/** GET /api/manual-steps/outstanding (Owed lens) — durable post-merge step records.
 *  Two rows: `deps`'s single owed (post-merge) step (mirrors its `holdStates` entry +
 *  `manualSteps` above), and `envflag`'s un-acked PRE-merge step (#1478 merged-card
 *  showcase — its `manualSteps`/`gitStates` entries above are the same session/step
 *  id so the Owed lens shows a real, workable checklist for the "Resolve" chip).
 *  Svelte's `{#each}` silently no-ops on the permissive `{}` fallback
 *  (`Array.from({})` → `[]`), so this gap never threw — it just left a showcased lens
 *  silently empty instead of showing the owed steps the seed already promises. */
function buildPostMergeSteps(): PostMergeSteps[] {
  return [
    {
      sessionId: "deps",
      desig: "TASK-37",
      repoPath: STOREFRONT,
      prNumber: 505,
      prTitle: "TASK-37: bump dependencies + fix lint",
      steps: [
        {
          id: "deps-ms-1",
          text: "Rotate the CI dependency-cache key so the runners pick up the new lockfile",
          postMerge: true,
          doneAt: null,
        },
      ],
      trackingIssueUrl: null,
      trackingIssueNumber: null,
      createdAt: NOW - 45 * MIN,
      updatedAt: NOW - 45 * MIN,
      clearedAt: null,
    },
    {
      sessionId: "envflag",
      desig: "TASK-50",
      repoPath: STOREFRONT,
      prNumber: 520,
      prTitle: "TASK-50: roll out feature X behind env flag",
      steps: [
        {
          id: "envflag-ms-1",
          text: "Set the FEATURE_X env var in production",
          postMerge: false,
          doneAt: null,
        },
      ],
      trackingIssueUrl: null,
      trackingIssueNumber: null,
      createdAt: NOW - 70 * MIN,
      updatedAt: NOW - 70 * MIN,
      clearedAt: null,
    },
  ];
}

/** Build a fresh, internally-consistent demo world. Pure — no shared references. */
export function buildSeed(): DemoWorld {
  return {
    sessions: buildSessions(),
    doneSessions: buildDoneSessions(),
    activityEntries: buildActivityEntries(),
    diffs: buildDiffs(),
    scratchpad: buildScratchpad(),
    sessionUsage: buildSessionUsage(),
    repoConfig: buildRepoConfig(),
    slashCommands: buildSlashCommands(),
    todo: buildTodo(),
    postMergeSteps: buildPostMergeSteps(),
    gitStates: buildGitStates(),
    activityStates: buildActivityStates(),
    claudeAliveStates: {
      coupon: true,
      "checkout-child": true,
      ogimg: true,
      neon: true,
      authstore: true,
      rounding: false,
      deps: false,
    },
    workingBlockedStates: {
      coupon: false,
      "checkout-child": false,
      // neon is genuinely blocked (autopilot-paused on an unanswered question) — a
      // `true` here would upgrade it to "running" in displayStatus() and hide it
      // from the Blocked lens. No session in this scenario is a stale-resumed showcase.
      neon: false,
    },
    holdStates: buildHolds(),
    subagentStates: buildSubagentStates(),
    previewStates: { coupon: { previewPort: 4173, serve: "ok" } },

    usage: buildUsage(),
    update: buildUpdate(),
    herdrUpdate: buildHerdrUpdate(),
    codexUpdate: buildCodexUpdate(),
    starPrompt: buildStarPrompt(),
    drain: buildDrain(),
    autoMerge: buildAutoMerge(),

    completedEpics: buildCompletedEpics(),
    epics: buildEpics(),
    settings: buildSettings(),
    plugins: buildPlugins(),
    diagnostics: buildDiagnostics(),
    backlog: buildBacklog(),
    buildQueues: buildBuildQueues(),
    held: buildHeld(),
    recaps: buildRecaps(),
    reviews: buildReviews(),
    planGates: buildPlanGates(),
    herdDigest: buildHerdDigest(),
    upNext: buildUpNext(),
    steers: buildSteers(),
    projectIcons: buildProjectIcons(),
    pendingLearnings: buildPendingLearnings(),
  };
}
