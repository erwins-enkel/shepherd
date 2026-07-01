// Pure seed data for the demo world. `buildSeed()` returns a fresh, deep-cloneable
// object graph — no timers, no bus, no imports from state/router/director. Every
// record is typed against `$lib/types`, so `tsc` proves each shape matches what the
// live UI consumes.
//
// Task 4: full scenario replaces/expands this seed. For now this is a MINIMAL but
// internally-consistent scenario — 1 repo (`acme/storefront`), 1 epic ("Checkout
// v2"), 3 sessions across running / planning / ready states — just enough that every
// getter returns a non-empty, correctly-shaped value.

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
} from "$lib/types";
import type { DemoWorld } from "./types-world";

const REPO = "/demo/acme/storefront";
const EPIC_PARENT = 100;

// A fixed clock anchor so the seed is deterministic (Task 6's director advances live
// timestamps at runtime). Offsets below are relative to this.
const NOW = Date.UTC(2026, 5, 30, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

/** Fill a full Session from a partial, defaulting every required field. */
function mkSession(partial: Partial<Session> & Pick<Session, "id" | "desig" | "name">): Session {
  return {
    prompt: "",
    repoPath: REPO,
    baseBranch: "main",
    branch: `shepherd/${partial.name}`,
    worktreePath: `${REPO}/.worktrees/${partial.id}`,
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

function buildSessions(): Session[] {
  return [
    mkSession({
      id: "s1",
      desig: "TASK-01",
      name: "checkout-api",
      prompt: "Implement the checkout payment-intent API endpoint",
      status: "running",
      autopilotEnabled: true,
      autopilotStepCount: 3,
      issueNumber: 101,
      lastState: "working",
      createdAt: NOW - 3 * HOUR,
    }),
    mkSession({
      id: "s2",
      desig: "TASK-02",
      name: "checkout-ui",
      prompt: "Build the checkout summary + confirm UI",
      status: "blocked",
      planGateEnabled: true,
      planPhase: "planning",
      issueNumber: 102,
      lastState: "blocked",
      createdAt: NOW - 90 * MIN,
    }),
    mkSession({
      id: "s3",
      desig: "TASK-03",
      name: "checkout-tests",
      prompt: "Add end-to-end checkout tests",
      status: "idle",
      readyToMerge: true,
      issueNumber: 103,
      lastState: "idle",
      createdAt: NOW - 4 * HOUR,
      updatedAt: NOW - 20 * MIN,
    }),
  ];
}

function buildGitStates(): Record<string, GitState> {
  return {
    s1: {
      kind: "github",
      state: "none",
      checks: "none",
      deployConfigured: false,
    },
    s3: {
      kind: "github",
      state: "open",
      number: 412,
      url: "https://github.com/acme/storefront/pull/412",
      title: "TASK-03: add end-to-end checkout tests",
      createdAt: NOW - 40 * MIN,
      mergeable: true,
      checks: "success",
      mergeStateStatus: "clean",
      deployConfigured: true,
      headSha: "9f3a1c7",
      issueUrl: "https://github.com/acme/storefront/issues/103",
    },
  };
}

function buildActivityStates(): Record<string, SessionActivity> {
  return {
    s1: {
      lastActivityTs: NOW - 30_000,
      summary: "edited payment-intent.ts",
      recentTs: [NOW - 5 * MIN, NOW - 3 * MIN, NOW - 90_000, NOW - 30_000],
      recentErrTs: [NOW - 3 * MIN],
    },
    s3: {
      lastActivityTs: NOW - 20 * MIN,
      summary: "$ bun test",
      recentTs: [NOW - 25 * MIN, NOW - 20 * MIN],
      recentErrTs: [],
    },
  };
}

function buildSubagentStates(): Record<string, SubagentEntry[]> {
  return {
    s1: [
      {
        agentId: "sub-s1-explore",
        agentType: "Explore",
        startedAt: NOW - 8 * MIN,
        endedAt: NOW - 6 * MIN,
      },
      { agentId: "sub-s1-impl", agentType: "general-purpose", startedAt: NOW - 4 * MIN },
    ],
  };
}

function buildUsage(): UsageLimitsResponse {
  return {
    limits: {
      session5h: { pct: 42, resetAt: NOW + 2 * HOUR },
      week: { pct: 61, resetAt: NOW + 3 * 24 * HOUR },
      credits: null,
      stale: false,
      calibratedAt: NOW - 10 * MIN,
      subscriptionOnly: false,
    },
    projections: [
      { window: "5H", projectedPct: 58, resetAt: NOW + 2 * HOUR, burnRatePerHour: 12 },
      { window: "WK", projectedPct: 74, resetAt: NOW + 3 * 24 * HOUR, burnRatePerHour: 40 },
    ],
  };
}

function buildEpics(): Epic[] {
  return [
    {
      repoPath: REPO,
      parentIssueNumber: EPIC_PARENT,
      parentTitle: "Checkout v2",
      source: "native",
      warnings: [],
      run: { repoPath: REPO, parentIssueNumber: EPIC_PARENT, mode: "attended", status: "running" },
      children: [
        {
          number: 101,
          title: "Payment-intent API",
          url: "https://github.com/acme/storefront/issues/101",
          order: 0,
          body: "Expose POST /api/checkout/intent.",
          blockedBy: [],
          state: "running",
          sessionId: "s1",
          prNumber: null,
          issueClosed: false,
          claimed: true,
        },
        {
          number: 102,
          title: "Checkout summary UI",
          url: "https://github.com/acme/storefront/issues/102",
          order: 1,
          body: "Render the summary + confirm screen.",
          blockedBy: [101],
          state: "blocked",
          sessionId: "s2",
          prNumber: null,
          issueClosed: false,
          claimed: true,
        },
        {
          number: 103,
          title: "Checkout e2e tests",
          url: "https://github.com/acme/storefront/issues/103",
          order: 2,
          body: "Playwright coverage for the happy path.",
          blockedBy: [101],
          state: "in-review",
          sessionId: "s3",
          prNumber: 412,
          issueClosed: false,
          claimed: true,
        },
      ],
    },
  ];
}

function buildCompletedEpics(): CompletedEpic[] {
  return [
    {
      repoPath: REPO,
      parentIssueNumber: 88,
      parentTitle: "Cart refactor",
      completedAt: NOW - 2 * 24 * HOUR,
      children: [
        {
          number: 81,
          title: "Cart store rewrite",
          url: "https://github.com/acme/storefront/issues/81",
          prNumber: 390,
          prUrl: "https://github.com/acme/storefront/pull/390",
          mergedAt: NOW - 2 * 24 * HOUR,
          integrated: true,
        },
      ],
      landingPrNumber: 395,
      landingPrUrl: "https://github.com/acme/storefront/pull/395",
      landingState: "merged",
      migrationPaths: [],
      migrationsAckedAt: null,
    },
  ];
}

function buildRecaps(): Record<string, Recap> {
  return {
    s3: {
      sessionId: "s3",
      state: "ready",
      headSha: "9f3a1c7",
      verdict: "ready",
      headline: "End-to-end checkout tests added",
      body: "Added Playwright coverage for the checkout happy path and a failing-card branch.",
      openItems: [],
      changedFiles: ["tests/checkout.spec.ts", "playwright.config.ts"],
      spawnSessionId: "recap-s3",
      cwd: `${REPO}/.worktrees/s3`,
      model: "opus",
      spawnedAt: NOW - 22 * MIN,
      generatedAt: NOW - 20 * MIN,
      updatedAt: NOW - 20 * MIN,
    },
  };
}

function buildReviews(): Record<string, ReviewVerdict> {
  return {
    s3: {
      sessionId: "s3",
      headSha: "9f3a1c7",
      decision: "commented",
      summary: "Solid coverage; one flaky selector to tighten.",
      body: "The happy-path spec is clear. Consider a data-testid on the confirm button.",
      findings: ["Use a stable data-testid for the confirm button"],
      addressRound: 0,
      addressCap: 3,
      finalRoundPending: false,
      finalRoundTimeoutMs: 120_000,
      url: "https://github.com/acme/storefront/pull/412#review",
      updatedAt: NOW - 18 * MIN,
    },
  };
}

function buildPlanGates(): Record<string, PlanGate> {
  return {
    s2: {
      sessionId: "s2",
      planHash: "plan-s2-hash-1",
      decision: "approved",
      summary: "Plan approved: build summary then confirm step.",
      body: "The two-step plan is sound. Wire the confirm CTA to the intent API from TASK-01.",
      findings: [],
      round: 1,
      cap: 3,
      approved: true,
      plan: "1. Render order summary\n2. Add confirm CTA\n3. Call payment-intent API",
      updatedAt: NOW - 12 * MIN,
    },
  };
}

function buildHerdDigest(): HerdDigest {
  return {
    dayKey: "2026-06-30",
    state: "ready",
    overnight: "Cart refactor epic landed; checkout v2 is mid-flight across three tasks.",
    decisions: [{ label: "Approved the checkout-ui plan gate", sessionId: "s2" }],
    ciRework: [],
    train: "No merge train running.",
    focusNext: [{ label: "Review TASK-03 checkout tests PR", sessionId: "s3", pr: 412 }],
    epicsToLand: [],
    attentionFingerprint: { s2: ["plan-approved"] },
    spawnSessionId: "digest-1",
    cwd: REPO,
    model: "opus",
    spawnedAt: NOW - 6 * HOUR,
    generatedAt: NOW - 6 * HOUR,
    updatedAt: NOW - 6 * HOUR,
  };
}

function buildUpNext(): UpNextSnapshot {
  return {
    generatedAt: NOW - 15 * MIN,
    repoCount: 1,
    fallback: null,
    failedRepoCount: 0,
    sections: [
      {
        kind: "repo",
        repoPath: REPO,
        repoSlug: "acme/storefront",
        repoLabel: "acme/storefront",
        totalCount: 1,
        items: [
          {
            repoPath: REPO,
            repoSlug: "acme/storefront",
            repoLabel: "acme/storefront",
            number: 120,
            title: "Add saved-payment-methods selector",
            url: "https://github.com/acme/storefront/issues/120",
            kind: "feature",
            priority: false,
            createdAt: NOW - 26 * HOUR,
            issueRef: {
              number: 120,
              url: "https://github.com/acme/storefront/issues/120",
              title: "Add saved-payment-methods selector",
              body: "Let returning customers pick a stored card at checkout.",
            },
          },
        ],
      },
    ],
  };
}

function buildBacklog(): BacklogPayload {
  return {
    pinnedPath: REPO,
    totals: { openIssues: 6, openPRs: 1 },
    projects: [
      {
        path: REPO,
        display: "acme/storefront",
        slug: "acme/storefront",
        kind: "github",
        lastUsedAt: NOW - 5 * MIN,
        recentAgentCount: 3,
        openIssues: 6,
        openPRs: 1,
        prKinds: { release: 0, dependabot: 0, regular: 1 },
        workflows: 2,
        ciStatus: "success",
        hidden: false,
      },
    ],
  };
}

function buildBuildQueues(): Record<string, BuildQueue> {
  return {
    s1: {
      sessionId: "s1",
      approved: true,
      approvalKind: "auto",
      steps: [
        { id: "step-1", title: "Draft payment-intent route", status: "done", position: 0 },
        { id: "step-2", title: "Wire Stripe client", status: "active", position: 1 },
        { id: "step-3", title: "Add unit tests", status: "pending", position: 2 },
      ],
    },
  };
}

function buildHeld(): HeldTask[] {
  return [
    {
      id: "held-1",
      repoPath: REPO,
      createdAt: NOW - 35 * MIN,
      input: {
        repoPath: REPO,
        baseBranch: "main",
        prompt: "Add refund flow to the checkout admin panel",
        model: "opus",
      },
    },
  ];
}

function buildSettings(): Settings {
  return {
    repoRoot: "/demo",
    repoRootDisplay: "~/demo",
    remoteControlAtStartup: false,
    sessionHousekeepingEnabled: true,
    defaultModel: "auto",
    criticCli: "inherit",
    criticModel: "default",
    plannerCli: "inherit",
    plannerModel: "default",
    recapCli: "inherit",
    recapModel: "default",
    docAgentCli: "inherit",
    docAgentModel: "default",
    namerCli: "inherit",
    namerModel: "default",
    autopilotCli: "inherit",
    autopilotModel: "default",
    defaultAgentProvider: "claude",
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
  ];
}

function buildDiagnostics(): DiagnosticsSnapshot {
  return {
    generatedAt: NOW - HOUR,
    overall: "ok",
    checks: [
      { id: "git", state: "ok", hintKey: "diag_git" },
      { id: "gh", state: "ok", hintKey: "diag_gh" },
      { id: "node", state: "ok", hintKey: "diag_node" },
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
  ];
}

function buildProjectIcons(): ProjectIcons {
  return { [REPO]: "🛒" };
}

function buildDrain(): DrainStatus[] {
  return [
    {
      repoPath: REPO,
      enabled: true,
      paused: false,
      reason: null,
      detail: null,
      queued: 4,
      inFlight: 1,
      max: 3,
      epicParent: EPIC_PARENT,
    },
  ];
}

function buildAutoMerge(): AutoMergeStatus[] {
  return [{ repoPath: REPO, enabled: true, state: null, detail: null, sessionId: null }];
}

function buildPendingLearnings(): Learning[] {
  return [
    {
      id: "learn-1",
      repoPath: REPO,
      rule: "Always add a data-testid to interactive checkout elements.",
      rationale: "Tests kept flaking on text-based selectors.",
      evidence: ["s3 review flagged a fragile selector"],
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
    s2: { code: "blocked-awaiting-input" },
  };
}

/** Build a fresh, internally-consistent demo world. Pure — no shared references. */
export function buildSeed(): DemoWorld {
  return {
    sessions: buildSessions(),
    gitStates: buildGitStates(),
    activityStates: buildActivityStates(),
    claudeAliveStates: { s1: true, s2: true, s3: true },
    workingBlockedStates: { s1: false, s2: false },
    holdStates: buildHolds(),
    subagentStates: buildSubagentStates(),
    previewStates: { s1: { previewPort: 4173, serve: "ok" } },

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
