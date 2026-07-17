/**
 * Tests for the #1071 rebase pass — `rebaseStuckLandingPrsForRepo` in drain.ts.
 *
 * All tests use an injected fake `rebaseLandingBranch` so no real git operations run.
 * The forge `prStatus` is also faked per-test.
 */
import { test, expect, describe } from "bun:test";
import { DrainService } from "../src/drain";
import { SessionStore } from "../src/store";
import type { GitForge, Issue, MergeInput, PrStatus, SubIssueRef } from "../src/forge/types";
import { EMPTY_BACKLOG_COUNTS } from "../src/forge/types";
import type { UsageLimits as UsageLimitsType } from "../src/usage-limits";
import type { CompletedEpic } from "../src/completed-epic";
import type { LandingRebaseResult } from "../src/landing-rebase";
import { epicIntegrationBranch } from "../src/epic-branch";

const REPO = "/repo";
const PARENT = 327;
const PARENT_TITLE = "EFI cluster";
const INTEGRATION_BRANCH = epicIntegrationBranch(PARENT, PARENT_TITLE); // epic/327-efi-cluster
const LANDING_PR = 555;

const NO_USAGE: UsageLimitsType = {
  session5h: null,
  week: null,
  perModelWeek: [],
  credits: null,
  stale: false,
  calibratedAt: null,
  subscriptionOnly: false,
};

/** A PR in the "behind" state (stuck, needs rebase). */
function behindPr(over: Partial<PrStatus> = {}): PrStatus {
  return {
    state: "open",
    number: LANDING_PR,
    url: `https://github.com/o/r/pull/${LANDING_PR}`,
    checks: "pending",
    mergeable: true,
    mergeStateStatus: "behind",
    headSha: "deadbeef",
    isDraft: false,
    deployConfigured: false,
    ...over,
  };
}

/** A PR in the "conflicting" state (stuck, genuine conflict). */
function conflictPr(over: Partial<PrStatus> = {}): PrStatus {
  return {
    state: "open",
    number: LANDING_PR,
    url: `https://github.com/o/r/pull/${LANDING_PR}`,
    checks: "failure",
    mergeable: false,
    mergeStateStatus: "dirty",
    headSha: "deadbeef",
    isDraft: false,
    deployConfigured: false,
    ...over,
  };
}

/** A PR that is not stuck (landable: not behind, not conflicting). */
function cleanPr(over: Partial<PrStatus> = {}): PrStatus {
  return {
    state: "open",
    number: LANDING_PR,
    url: `https://github.com/o/r/pull/${LANDING_PR}`,
    checks: "success",
    mergeable: true,
    mergeStateStatus: "clean",
    headSha: "deadbeef",
    isDraft: false,
    deployConfigured: false,
    ...over,
  };
}

interface MergeCall {
  prNumber: number;
  method: string;
}

interface ForgeSpy {
  forge: GitForge;
  mergeCalls: MergeCall[];
  prStatusCalls: string[];
}

function fakeForge(opts: {
  kind?: "github" | "gitea" | "local";
  prStatus?: (branch: string) => Promise<PrStatus>;
  merge?: (prNumber: number, o: MergeInput) => Promise<void>;
}): ForgeSpy {
  const mergeCalls: MergeCall[] = [];
  const prStatusCalls: string[] = [];
  const forge: GitForge = {
    kind: opts.kind ?? "github",
    slug: "o/r",
    mergeMethod: "squash",
    deployWorkflow: null,
    listIssues: async () => [],
    listPullRequests: async () => [],
    listBacklogCounts: async () => EMPTY_BACKLOG_COUNTS,
    prStatus: async (branch: string) => {
      prStatusCalls.push(branch);
      return (
        (await opts.prStatus?.(branch)) ??
        ({ state: "none", checks: "none", deployConfigured: false } as PrStatus)
      );
    },
    openPr: async () => ({ state: "open", checks: "none", deployConfigured: false }) as PrStatus,
    defaultBranch: async () => "main",
    merge: async (prNumber: number, o: MergeInput) => {
      mergeCalls.push({ prNumber, method: o.method });
      await opts.merge?.(prNumber, o);
    },
    redeploy: async () => {},
    postReview: async () => ({}),
    closeIssue: async () => {},
    ensureIssueLink: async () => {},
    addIssueLabel: async () => {},
    removeIssueLabel: async () => {},
    getIssue: async (): Promise<Issue | null> => null,
    listSubIssues: async (): Promise<SubIssueRef[]> => [],
    listBlockedBy: async () => [],
  };
  return { forge, mergeCalls, prStatusCalls };
}

interface Harness {
  store: SessionStore;
  drain: DrainService;
  completedEmits: CompletedEpic[];
  spy: ForgeSpy;
  rebaseCalls: Array<{ repoPath: string; branch: string; defaultBranch: string }>;
}

function makeHarness(opts: {
  autoMergeEnabled?: boolean;
  autoDrainEnabled?: boolean;
  epicRunning?: boolean;
  draftMode?: boolean;
  rebaseCap?: number;
  prStatus?: (branch: string) => Promise<PrStatus>;
  rebaseLandingBranch?: () => Promise<LandingRebaseResult>;
  /** When false, use a gitea forge (non-github). */
  github?: boolean;
  /** Inject the driver-registered probe (DI seam) so the fast-path is deterministic. */
  isDriverRegistered?: (repoPath: string) => Promise<boolean>;
}): Harness {
  const store = new SessionStore(":memory:");
  store.setRepoConfig(REPO, {
    criticEnabled: false,
    criticAllPrs: false,
    criticSmellLensEnabled: false,
    autoAddressEnabled: false,
    learningsEnabled: false,
    autopilotEnabled: false,
    planGateEnabled: false,
    autoDrainEnabled: opts.autoDrainEnabled ?? false,
    autoMergeEnabled: opts.autoMergeEnabled ?? false,
    buildQueueEnabled: false,
    draftMode: opts.draftMode ?? false,
    signoffAuthority: "human",
    maxAuto: 2,
    autoLabel: "shepherd:auto",
    usageCeilingPct: 80,
    sandboxProfile: "trusted",
    defaultModel: "inherit",
    defaultEffort: "inherit",
    previewOpenMode: "ask",
    egressExtraHosts: [],
    repoMode: "forge",
    autoOptimizeFlagged: false,
    manualStepsIssueEnabled: false,
    preWarmEpicLandingCi: false,
    hidden: false,
  });

  if (opts.epicRunning) {
    store.setEpicRun({
      repoPath: REPO,
      parentIssueNumber: PARENT,
      mode: "auto",
      status: "running",
    });
  }

  const spy = fakeForge({
    kind: opts.github === false ? "gitea" : "github",
    prStatus: opts.prStatus,
  });
  const completedEmits: CompletedEpic[] = [];
  const rebaseCalls: Array<{ repoPath: string; branch: string; defaultBranch: string }> = [];

  const fakeRebase = async (
    repoPath: string,
    branch: string,
    defaultBranch: string,
  ): Promise<LandingRebaseResult> => {
    rebaseCalls.push({ repoPath, branch, defaultBranch });
    return (await opts.rebaseLandingBranch?.()) ?? { kind: "current" };
  };

  const drain = new DrainService({
    store,
    service: {
      create: async () => {
        throw new Error("not used");
      },
      archive: () => 1,
    } as never,
    resolveForge: () => spy.forge,
    prCache: { snapshot: () => ({}) },
    usage: { limits: (): UsageLimitsType => NO_USAGE },
    repos: () => [REPO],
    emitStatus: () => {},
    emitArchived: () => {},
    dropPrCache: () => {},
    emitEpic: () => {},
    emitEpicCompleted: (e) => completedEmits.push(e),
    rebaseCap: opts.rebaseCap ?? 5,
    rebaseLandingBranch: fakeRebase,
    isDriverRegistered: opts.isDriverRegistered,
  });

  return { store, drain, completedEmits, spy, rebaseCalls };
}

/** Seed an `epic_completed` row with landingState='open' and a pinned integration branch. */
function seedOpenLanding(
  h: Harness,
  opts: {
    migrations?: string[];
    pin?: boolean;
    rebaseCount?: number;
    driverMisses?: number;
    pauseReason?: "cap" | "conflict" | "driver" | null;
  } = {},
): void {
  h.store.recordEpicIntegrated(REPO, PARENT, 320, {
    number: 9320,
    url: "https://github.com/o/r/pull/9320",
  });
  h.store.recordEpicCompleted({
    repoPath: REPO,
    parentIssueNumber: PARENT,
    parentTitle: PARENT_TITLE,
    completedAt: 1,
    childrenJson: JSON.stringify([
      {
        number: 320,
        title: "child 320",
        url: "https://x/320",
        prNumber: 9320,
        prUrl: "https://github.com/o/r/pull/9320",
        mergedAt: 1,
        integrated: true,
      },
    ]),
  });
  if (opts.pin !== false) {
    h.store.getOrInitEpicIntegrationBranch(REPO, PARENT, INTEGRATION_BRANCH);
  }
  h.store.setEpicLandingPr(REPO, PARENT, {
    state: "open",
    prNumber: LANDING_PR,
    prUrl: `https://github.com/o/r/pull/${LANDING_PR}`,
    attempts: 0,
  });
  if (opts.migrations && opts.migrations.length > 0) {
    h.store.setEpicMigrationPaths(REPO, PARENT, opts.migrations);
  }
  if (
    opts.rebaseCount !== undefined ||
    opts.driverMisses !== undefined ||
    opts.pauseReason !== undefined
  ) {
    h.store.setEpicLandingRebaseState(REPO, PARENT, {
      count: opts.rebaseCount,
      driverMisses: opts.driverMisses,
      pauseReason: opts.pauseReason,
    });
  }
}

const row = (h: Harness) => h.store.listEpicCompleted(REPO)[0]!;

/** Invoke the private rebase pass directly so prStatus call counts are isolated to it
 *  (tick() also runs autoLandLandingPrsForRepo, which reads prStatus). */
function callRebasePass(h: Harness): Promise<void> {
  return (
    h.drain as unknown as { rebaseStuckLandingPrsForRepo: (repoPath: string) => Promise<void> }
  ).rebaseStuckLandingPrsForRepo(REPO);
}

describe("rebaseStuckLandingPrsForRepo (#1071)", () => {
  // ── gate tests ──────────────────────────────────────────────────────────────

  test("gate-off: draftMode ON → forge.prStatus NOT called", async () => {
    const h = makeHarness({
      draftMode: true,
      autoMergeEnabled: true,
      prStatus: async () => behindPr(),
    });
    seedOpenLanding(h);

    await h.drain.tick();

    expect(h.spy.prStatusCalls).toHaveLength(0);
    expect(h.rebaseCalls).toHaveLength(0);
  });

  test("gate-off: autoMerge+autoDrain off, no running epic → forge.prStatus NOT called", async () => {
    const h = makeHarness({
      autoMergeEnabled: false,
      autoDrainEnabled: false,
      prStatus: async () => behindPr(),
    });
    seedOpenLanding(h);

    await h.drain.tick();

    expect(h.spy.prStatusCalls).toHaveLength(0);
    expect(h.rebaseCalls).toHaveLength(0);
  });

  test("gate: autoMergeEnabled ON (autoDrain off, no epic) → pass runs (prStatus called)", async () => {
    const h = makeHarness({
      autoMergeEnabled: true,
      autoDrainEnabled: false,
      prStatus: async () => cleanPr(),
    });
    seedOpenLanding(h);

    await h.drain.tick();

    expect(h.spy.prStatusCalls.length).toBeGreaterThan(0);
  });

  test("gate: autoDrainEnabled ON (autoMerge off, no epic) → pass runs", async () => {
    const h = makeHarness({
      autoMergeEnabled: false,
      autoDrainEnabled: true,
      prStatus: async () => cleanPr(),
    });
    seedOpenLanding(h);

    await h.drain.tick();

    expect(h.spy.prStatusCalls.length).toBeGreaterThan(0);
  });

  test("epic-running engages: autoMerge+autoDrain off but epic status=running → pass runs", async () => {
    const h = makeHarness({
      autoMergeEnabled: false,
      autoDrainEnabled: false,
      epicRunning: true,
      prStatus: async () => cleanPr(),
    });
    seedOpenLanding(h);

    await h.drain.tick();

    expect(h.spy.prStatusCalls.length).toBeGreaterThan(0);
  });

  test("non-github forge → rebaseLandingBranch NOT called (rebase pass skips gitea)", async () => {
    // The rebase pass is GitHub-only (forge.kind !== 'github' → skips). The autoLandLandingPrsForRepo
    // pass may still call prStatus for gitea when autoMergeEnabled is on — but that's a different pass.
    // We assert the rebase pass itself did nothing (no rebaseCalls).
    const h = makeHarness({
      autoMergeEnabled: true,
      github: false,
      prStatus: async () => behindPr(),
    });
    seedOpenLanding(h);

    await h.drain.tick();

    expect(h.rebaseCalls).toHaveLength(0);
    // Row is still in initial state (no rebase state changes).
    expect(row(h).landingRebaseCount).toBe(0);
  });

  // ── rebase-on-stuck tests ───────────────────────────────────────────────────

  test("rebase-on-behind: mergeStateStatus=behind → rebaseLandingBranch called; on rebased → count++, merge NOT called", async () => {
    const h = makeHarness({
      autoMergeEnabled: true,
      prStatus: async () => behindPr(),
      rebaseLandingBranch: async () => ({ kind: "rebased", headSha: "newsha" }),
    });
    seedOpenLanding(h);

    await h.drain.tick();

    expect(h.rebaseCalls).toHaveLength(1);
    expect(row(h).landingRebaseCount).toBe(1);
    expect(row(h).landingRebaseDriverMisses).toBe(0);
    expect(row(h).landingRebasePauseReason).toBeNull();
    expect(h.spy.mergeCalls).toHaveLength(0); // NEVER merges
  });

  test("rebase-on-conflicting: mergeable=false → rebaseLandingBranch called", async () => {
    const h = makeHarness({
      autoMergeEnabled: true,
      prStatus: async () => conflictPr(),
      rebaseLandingBranch: async () => ({ kind: "rebased", headSha: "newsha" }),
    });
    seedOpenLanding(h);

    await h.drain.tick();

    expect(h.rebaseCalls).toHaveLength(1);
    expect(row(h).landingRebaseCount).toBe(1);
    expect(h.spy.mergeCalls).toHaveLength(0);
  });

  test("not-stuck PR (clean): rebaseLandingBranch NOT called, no state change", async () => {
    const h = makeHarness({
      autoMergeEnabled: true,
      prStatus: async () => cleanPr(),
    });
    seedOpenLanding(h);

    await h.drain.tick();

    expect(h.rebaseCalls).toHaveLength(0);
    expect(row(h).landingRebaseCount).toBe(0);
  });

  // ── result-union → drain action table ───────────────────────────────────────

  test("rebased result → count incremented, driverMisses reset to 0, emitCompleted fired", async () => {
    const h = makeHarness({
      autoMergeEnabled: true,
      prStatus: async () => behindPr(),
      rebaseLandingBranch: async () => ({ kind: "rebased", headSha: "abc" }),
    });
    seedOpenLanding(h, { rebaseCount: 2, driverMisses: 1 });

    await h.drain.tick();

    expect(row(h).landingRebaseCount).toBe(3);
    expect(row(h).landingRebaseDriverMisses).toBe(0); // reset on rebased
    expect(h.completedEmits.length).toBeGreaterThan(0);
  });

  test("current result → all counters reset to 0 (no double-count on GitHub lag)", async () => {
    const h = makeHarness({
      autoMergeEnabled: true,
      prStatus: async () => behindPr(),
      rebaseLandingBranch: async () => ({ kind: "current" }),
    });
    seedOpenLanding(h, { rebaseCount: 2, driverMisses: 0 });

    await h.drain.tick();

    expect(row(h).landingRebaseCount).toBe(0); // reset
    expect(row(h).landingRebasePauseReason).toBeNull();
    expect(h.completedEmits.length).toBeGreaterThan(0);
  });

  test("conflict result → pauseReason='conflict', emitCompleted fired", async () => {
    const h = makeHarness({
      autoMergeEnabled: true,
      prStatus: async () => conflictPr(),
      rebaseLandingBranch: async () => ({ kind: "conflict" }),
    });
    seedOpenLanding(h);

    await h.drain.tick();

    expect(row(h).landingRebasePauseReason).toBe("conflict");
    expect(h.completedEmits.length).toBeGreaterThan(0);
  });

  test("transient result → no state change, no count burn, retried next cycle", async () => {
    const h = makeHarness({
      autoMergeEnabled: true,
      prStatus: async () => behindPr(),
      rebaseLandingBranch: async () => ({ kind: "transient" }),
    });
    seedOpenLanding(h, { rebaseCount: 1 });

    await h.drain.tick();

    expect(row(h).landingRebaseCount).toBe(1); // unchanged
    expect(row(h).landingRebasePauseReason).toBeNull();
  });

  // ── cap exhaustion ───────────────────────────────────────────────────────────

  test("cap-exhaustion: row already at rebaseCap, stuck → pauseReason='cap', rebaseLandingBranch NOT called", async () => {
    const h = makeHarness({
      autoMergeEnabled: true,
      rebaseCap: 3,
      prStatus: async () => behindPr(),
    });
    seedOpenLanding(h, { rebaseCount: 3 }); // at cap

    await h.drain.tick();

    expect(h.rebaseCalls).toHaveLength(0); // cap hit before rebase
    expect(row(h).landingRebasePauseReason).toBe("cap");
    expect(h.spy.mergeCalls).toHaveLength(0);
    expect(h.completedEmits.length).toBeGreaterThan(0);
  });

  test("hot-default: consecutive ticks with always-behind PR → count climbs to cap → pauses", async () => {
    // Each tick returns 'rebased' (genuine advance). The PR stays 'behind' after each push
    // (GitHub CI restarts). After rebaseCap ticks, the pass pauses.
    const CAP = 3;
    let prStatusCalls = 0;
    const h = makeHarness({
      autoMergeEnabled: true,
      rebaseCap: CAP,
      prStatus: async () => {
        prStatusCalls++;
        return behindPr();
      },
      rebaseLandingBranch: async () => ({ kind: "rebased", headSha: `sha-${prStatusCalls}` }),
    });
    seedOpenLanding(h);

    // Tick CAP times: each should increment the count.
    for (let i = 0; i < CAP; i++) {
      await h.drain.tick();
      expect(row(h).landingRebaseCount).toBe(i + 1);
    }

    // One more tick: count is at cap → pause.
    await h.drain.tick();
    expect(row(h).landingRebasePauseReason).toBe("cap");
    // No further rebase beyond the cap tick.
    expect(h.rebaseCalls.length).toBe(CAP); // exactly CAP rebase calls
  });

  // ── driver-fault escalation ──────────────────────────────────────────────────

  test("single driver-fault: driverMisses increments, no pause, no count burn", async () => {
    const h = makeHarness({
      autoMergeEnabled: true,
      prStatus: async () => behindPr(),
      rebaseLandingBranch: async () => ({ kind: "driver-absent" }),
    });
    seedOpenLanding(h);

    await h.drain.tick();

    expect(row(h).landingRebaseDriverMisses).toBe(1);
    expect(row(h).landingRebasePauseReason).toBeNull(); // no pause yet
    expect(row(h).landingRebaseCount).toBe(0); // no cap burn
  });

  test("driver-broken routes to driver-fault bucket (no conflict pause)", async () => {
    const h = makeHarness({
      autoMergeEnabled: true,
      prStatus: async () => behindPr(),
      rebaseLandingBranch: async () => ({ kind: "driver-broken" }),
    });
    seedOpenLanding(h);

    await h.drain.tick();

    // driver-broken → same as driver-absent: increments driverMisses, NOT a conflict pause
    expect(row(h).landingRebaseDriverMisses).toBe(1);
    expect(row(h).landingRebasePauseReason).toBeNull();
    expect(row(h).landingRebaseCount).toBe(0);
  });

  test("driver-fault escalation: K consecutive misses → pauseReason='driver'", async () => {
    // DRIVER_MISS_CAP is 3 in drain.ts
    const MISS_CAP = 3;
    const h = makeHarness({
      autoMergeEnabled: true,
      prStatus: async () => behindPr(),
      rebaseLandingBranch: async () => ({ kind: "driver-absent" }),
    });
    seedOpenLanding(h);

    // First MISS_CAP - 1 ticks: increments driverMisses, no pause.
    for (let i = 0; i < MISS_CAP - 1; i++) {
      await h.drain.tick();
      expect(row(h).landingRebaseDriverMisses).toBe(i + 1);
      expect(row(h).landingRebasePauseReason).toBeNull();
      expect(row(h).landingRebaseCount).toBe(0); // no cap burn
    }

    // K-th miss → pause with 'driver'.
    await h.drain.tick();
    expect(row(h).landingRebaseDriverMisses).toBe(MISS_CAP);
    expect(row(h).landingRebasePauseReason).toBe("driver");
    expect(row(h).landingRebaseCount).toBe(0); // still no cap burn
    expect(h.completedEmits.length).toBeGreaterThan(0);
  });

  // ── driver-pause fast-path ───────────────────────────────────────────────────

  test("driver-pause: driver NOT registered → ZERO forge.prStatus calls, no rebase, stays paused", async () => {
    // Inject a fake probe returning false. The fast-path must short-circuit BEFORE any
    // forge.prStatus call. Call the rebase pass directly (not tick()) so the prStatus count
    // is isolated to this pass (tick() also runs autoLandLandingPrsForRepo, which reads prStatus).
    const h = makeHarness({
      autoMergeEnabled: true,
      prStatus: async () => behindPr(),
      isDriverRegistered: async () => false,
    });
    seedOpenLanding(h, { pauseReason: "driver", driverMisses: 3 });

    await callRebasePass(h);

    expect(h.spy.prStatusCalls).toHaveLength(0); // ZERO forge call when driver-paused + absent
    expect(h.rebaseCalls).toHaveLength(0);
    // State unchanged: still paused with 'driver'.
    expect(row(h).landingRebasePauseReason).toBe("driver");
    expect(row(h).landingRebaseDriverMisses).toBe(3); // unchanged
  });

  test("driver-pause fast-path: driver NOW registered → pause cleared, pass proceeds (prStatus called)", async () => {
    // Inject a fake probe returning true. The fast-path clears the pause and falls through to
    // probe prStatus + (since the PR is behind) attempt the rebase.
    const h = makeHarness({
      autoMergeEnabled: true,
      prStatus: async () => behindPr(),
      isDriverRegistered: async () => true,
      rebaseLandingBranch: async () => ({ kind: "rebased", headSha: "recovered" }),
    });
    seedOpenLanding(h, { pauseReason: "driver", driverMisses: 3 });

    await callRebasePass(h);

    // Pause cleared, prStatus probed, rebase attempted.
    expect(h.spy.prStatusCalls.length).toBeGreaterThan(0);
    expect(h.rebaseCalls).toHaveLength(1);
    expect(row(h).landingRebasePauseReason).toBeNull();
    // driverMisses reset to 0 by the fast-path clear, then count++ from the rebased result.
    expect(row(h).landingRebaseDriverMisses).toBe(0);
    expect(row(h).landingRebaseCount).toBe(1);
  });

  // ── pause states ─────────────────────────────────────────────────────────────

  test("cap-pause: already paused with 'cap', stuck → stay paused, no rebase", async () => {
    const h = makeHarness({
      autoMergeEnabled: true,
      prStatus: async () => behindPr(),
    });
    seedOpenLanding(h, { rebaseCount: 5, pauseReason: "cap" });

    await h.drain.tick();

    expect(h.rebaseCalls).toHaveLength(0);
    expect(row(h).landingRebasePauseReason).toBe("cap"); // unchanged
  });

  test("cap-pause cleared when PR becomes not-stuck (operator rebased manually)", async () => {
    const h = makeHarness({
      autoMergeEnabled: true,
      prStatus: async () => cleanPr(), // now clean/not-stuck
    });
    seedOpenLanding(h, { rebaseCount: 5, pauseReason: "cap" });

    await h.drain.tick();

    expect(row(h).landingRebasePauseReason).toBeNull(); // cleared
    expect(row(h).landingRebaseCount).toBe(0);
  });

  test("conflict-pause: pauseReason='conflict' + PR still conflicting → stay paused", async () => {
    const h = makeHarness({
      autoMergeEnabled: true,
      prStatus: async () => conflictPr(), // still conflicting
    });
    seedOpenLanding(h, { pauseReason: "conflict" });

    await h.drain.tick();

    expect(h.rebaseCalls).toHaveLength(0);
    expect(row(h).landingRebasePauseReason).toBe("conflict"); // unchanged
  });

  test("conflict-pause resume: operator resolved conflict (PR now behind-only) → pause cleared, rebase attempted", async () => {
    const h = makeHarness({
      autoMergeEnabled: true,
      // PR is now behind-only (operator resolved the conflict content),
      // but still 'behind' so it still needs a rebase.
      prStatus: async () => behindPr({ mergeable: true }), // mergeable=true but behind
      rebaseLandingBranch: async () => ({ kind: "rebased", headSha: "newsha" }),
    });
    seedOpenLanding(h, { pauseReason: "conflict", rebaseCount: 0 });

    await h.drain.tick();

    // Pause cleared; rebase attempted.
    expect(h.rebaseCalls).toHaveLength(1);
    expect(row(h).landingRebasePauseReason).toBeNull();
    expect(row(h).landingRebaseCount).toBe(1);
  });

  // ── reset-on-landable ────────────────────────────────────────────────────────

  test("reset-on-landable: stuck row with count>0 becomes not-stuck → counters/pauseReason cleared", async () => {
    const h = makeHarness({
      autoMergeEnabled: true,
      prStatus: async () => cleanPr(), // now landable
    });
    seedOpenLanding(h, { rebaseCount: 3, driverMisses: 1 });

    await h.drain.tick();

    expect(row(h).landingRebaseCount).toBe(0);
    expect(row(h).landingRebaseDriverMisses).toBe(0);
    expect(row(h).landingRebasePauseReason).toBeNull();
    expect(h.completedEmits.length).toBeGreaterThan(0);
  });

  // ── migration-bearing rows ───────────────────────────────────────────────────

  test("migration-bearing row is rebased (not merged) — never auto-merges", async () => {
    // Per plan: unlike autoLandLandingPrsForRepo, the rebase pass processes migration-bearing
    // rows too (they need a rebase to stay mergeable for the operator's manual ack/land CTA).
    const h = makeHarness({
      autoMergeEnabled: true,
      prStatus: async () => behindPr(),
      rebaseLandingBranch: async () => ({ kind: "rebased", headSha: "migsha" }),
    });
    seedOpenLanding(h, { migrations: ["server/migrations/001.sql"] });

    await h.drain.tick();

    // Rebase was called (migration rows ARE rebased).
    expect(h.rebaseCalls).toHaveLength(1);
    expect(row(h).landingRebaseCount).toBe(1);
    // But merge was never called.
    expect(h.spy.mergeCalls).toHaveLength(0);
  });

  // ── never-merges ─────────────────────────────────────────────────────────────

  test("never-merges: forge.merge is never invoked by this pass in any scenario", async () => {
    // Test multiple scenarios: behind→rebased, conflicting→conflict, cap, driver-fault.
    const scenarios: Array<{
      label: string;
      prStatus: PrStatus;
      rebaseResult: LandingRebaseResult;
      rebaseCount?: number;
      pauseReason?: "cap" | "conflict" | "driver" | null;
    }> = [
      { label: "rebased", prStatus: behindPr(), rebaseResult: { kind: "rebased", headSha: "x" } },
      { label: "conflict", prStatus: conflictPr(), rebaseResult: { kind: "conflict" } },
      { label: "driver-absent", prStatus: behindPr(), rebaseResult: { kind: "driver-absent" } },
      { label: "transient", prStatus: behindPr(), rebaseResult: { kind: "transient" } },
      {
        label: "cap",
        prStatus: behindPr(),
        rebaseResult: { kind: "current" },
        rebaseCount: 5,
      },
    ];

    for (const scenario of scenarios) {
      const h = makeHarness({
        autoMergeEnabled: true,
        prStatus: async () => scenario.prStatus,
        rebaseLandingBranch: async () => scenario.rebaseResult,
        rebaseCap: 5,
      });
      seedOpenLanding(h, {
        rebaseCount: scenario.rebaseCount,
        pauseReason: scenario.pauseReason,
      });

      await h.drain.tick();

      expect(h.spy.mergeCalls).toHaveLength(0);
    }
  });

  // ── unpinned branch ──────────────────────────────────────────────────────────

  test("unpinned integration branch → skip cleanly, no rebase", async () => {
    const h = makeHarness({
      autoMergeEnabled: true,
      prStatus: async () => behindPr(),
    });
    seedOpenLanding(h, { pin: false }); // no pin → getEpicIntegrationBranch returns null

    await h.drain.tick();

    expect(h.rebaseCalls).toHaveLength(0);
    expect(h.spy.prStatusCalls).toHaveLength(0);
  });

  // ── PR not open ──────────────────────────────────────────────────────────────

  test("PR state=closed → skip (let reconcile own it), no rebase", async () => {
    const h = makeHarness({
      autoMergeEnabled: true,
      prStatus: async () => behindPr({ state: "closed" }),
    });
    seedOpenLanding(h);

    await h.drain.tick();

    expect(h.rebaseCalls).toHaveLength(0);
  });

  test("PR state=merged → skip, no rebase", async () => {
    const h = makeHarness({
      autoMergeEnabled: true,
      prStatus: async () => behindPr({ state: "merged" }),
    });
    seedOpenLanding(h);

    await h.drain.tick();

    expect(h.rebaseCalls).toHaveLength(0);
  });
});
