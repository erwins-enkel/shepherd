/**
 * #2873: the drain's landing passes (rebase, CI re-run, auto-land, pre-warm) share one landing-PR
 * read per tick, and leave a settled landing PR alone while the repo's PR fingerprint holds.
 * Acceptance: one read per tick; no per-head lookups for 10 min on a settled PR with an unchanged
 * fingerprint; auto-land and the red-CI re-run still fire within one tick of the enabling change.
 */
import { test, expect, describe } from "bun:test";
import { DrainService } from "../src/drain";
import { SessionStore } from "../src/store";
import type { GitForge, Issue, OpenPrSnapshot, PrStatus, SubIssueRef } from "../src/forge/types";
import { EMPTY_BACKLOG_COUNTS } from "../src/forge/types";
import type { UsageLimits as UsageLimitsType } from "../src/usage-limits";
import { epicIntegrationBranch } from "../src/epic-branch";
import { LANDING_PR_RECHECK_MS } from "../src/landing-pr-reads";

const REPO = "/repo";
const PARENT = 327;
const PARENT_TITLE = "EFI cluster";
const BRANCH = epicIntegrationBranch(PARENT, PARENT_TITLE);
const LANDING_PR = 555;
const TICK_MS = 30_000;

const NO_USAGE: UsageLimitsType = {
  session5h: null,
  week: null,
  perModelWeek: [],
  credits: null,
  stale: false,
  calibratedAt: null,
  subscriptionOnly: false,
};

/** An open landing PR with completed checks waiting for an approval (#2754's state). */
function pr(over: Partial<PrStatus> = {}): PrStatus {
  return {
    state: "open",
    number: LANDING_PR,
    url: `https://github.com/o/r/pull/${LANDING_PR}`,
    checks: "success",
    mergeable: true,
    mergeStateStatus: "blocked",
    headSha: "h1",
    isDraft: false,
    deployConfigured: false,
    ...over,
  };
}

interface Harness {
  store: SessionStore;
  drain: DrainService;
  /** `prStatus` calls on the landing branch. */
  reads: () => number;
  merges: number[];
  reruns: number[];
  rebases: string[];
  setPr: (s: PrStatus | Error) => void;
  setKey: (k: string | null) => void;
  setNow: (ms: number) => void;
  setSnapshot: (s: { at: number; value: OpenPrSnapshot } | null) => void;
  /** Tick every 30 s from the current clock until `untilMs` (inclusive). */
  tickUntil: (untilMs: number) => Promise<void>;
  now: () => number;
}

function makeHarness(
  opts: {
    autoMergeEnabled?: boolean;
    preWarm?: boolean;
    freshness?: boolean;
    rebase?: () => Promise<{ kind: "rebased"; headSha: string } | { kind: "current" }>;
    /** The landing PR's latest failed Actions run; null = nothing the re-run pass can re-run. */
    failedRun?: number | null;
    /** Make every merge attempt fail with this message (the PR stays open). */
    mergeError?: string;
  } = {},
): Harness {
  let now = 0;
  let key: string | null = "k1";
  let status: PrStatus | Error = pr();
  let snapshot: { at: number; value: OpenPrSnapshot } | null = null;
  let reads = 0;
  const merges: number[] = [];
  const reruns: number[] = [];
  const rebases: string[] = [];

  const store = new SessionStore(":memory:");
  store.setRepoConfig(REPO, {
    criticEnabled: false,
    criticAllPrs: false,
    criticSmellLensEnabled: false,
    autoAddressEnabled: false,
    learningsEnabled: false,
    autopilotEnabled: false,
    planGateEnabled: false,
    autoDrainEnabled: false, // keep pump() off → tick() exercises only the landing passes
    autoMergeEnabled: opts.autoMergeEnabled ?? true,
    buildQueueEnabled: false,
    draftMode: false,
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
    preWarmEpicLandingCi: opts.preWarm ?? false,
    epicStacksEnabled: false,
    sharedBrowserEnabled: false,
    browserAllowedHosts: [],
    hidden: false,
  });

  const forge: GitForge = {
    kind: "github",
    slug: "o/r",
    mergeMethod: "squash",
    deployWorkflow: null,
    listIssues: async () => [],
    listPullRequests: async () => [],
    listBacklogCounts: async () => EMPTY_BACKLOG_COUNTS,
    prStatus: async (branch: string) => {
      if (branch === BRANCH) reads++;
      if (status instanceof Error) throw status;
      return status;
    },
    openPr: async () => ({ state: "open", checks: "none", deployConfigured: false }) as PrStatus,
    defaultBranch: async () => "main",
    merge: async (prNumber: number) => {
      merges.push(prNumber);
      if (opts.mergeError) throw new Error(opts.mergeError);
      status = pr({ state: "merged" });
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
    latestFailedRunForPr: async () => (opts.failedRun === undefined ? 42 : opts.failedRun),
    rerunWorkflowRun: async (runId: number) => {
      reruns.push(runId);
    },
  };

  const drain = new DrainService({
    store,
    service: {
      create: async () => ({ id: "repair-sess", baseBranch: BRANCH }) as never,
      archive: () => 1,
    } as never,
    resolveForge: () => forge,
    prCache: { snapshot: () => ({}) },
    usage: { limits: (): UsageLimitsType => NO_USAGE },
    repos: () => [REPO],
    emitStatus: () => {},
    emitArchived: () => {},
    dropPrCache: () => {},
    now: () => now,
    rebaseCap: 5,
    rebaseLandingBranch: async (_repo, branch) => {
      rebases.push(branch);
      return opts.rebase ? opts.rebase() : { kind: "current" };
    },
    prFreshness: opts.freshness === false ? undefined : () => key,
    openPrSnapshot: { peekCurrent: () => snapshot },
  });

  const h: Harness = {
    store,
    drain,
    reads: () => reads,
    merges,
    reruns,
    rebases,
    setPr: (s) => (status = s),
    setKey: (k) => (key = k),
    setNow: (ms) => (now = ms),
    setSnapshot: (s) => (snapshot = s),
    now: () => now,
    tickUntil: async (untilMs) => {
      for (; now <= untilMs; now += TICK_MS) await drain.tick();
      now -= TICK_MS; // leave the clock on the last tick
    },
  };
  return h;
}

/** An open `epic_completed` row with a recorded landing PR on the pinned integration branch. */
function seedOpenLanding(h: Harness): void {
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
  h.store.getOrInitEpicIntegrationBranch(REPO, PARENT, BRANCH);
  h.store.setEpicLandingPr(REPO, PARENT, {
    state: "open",
    prNumber: LANDING_PR,
    prUrl: `https://github.com/o/r/pull/${LANDING_PR}`,
    attempts: 0,
  });
}

const row = (h: Harness) => h.store.listEpicCompleted(REPO)[0]!;

describe("one landing-PR read per tick", () => {
  test("rebase, re-run and auto-land share one read (CI running → read every tick)", async () => {
    const h = makeHarness();
    h.setPr(pr({ checks: "pending", runningChecks: ["ci / test"], mergeStateStatus: "blocked" }));
    seedOpenLanding(h);
    await h.tickUntil(2 * TICK_MS);
    expect(h.reads()).toBe(3);
  });

  test("without a fingerprint every tick reads, still once", async () => {
    const h = makeHarness({ freshness: false });
    seedOpenLanding(h);
    await h.tickUntil(2 * TICK_MS);
    expect(h.reads()).toBe(3);
  });

  test("a failing read is not retried by the next pass of the same tick", async () => {
    const h = makeHarness();
    h.setPr(new Error("gh down"));
    seedOpenLanding(h);
    await h.drain.tick();
    expect(h.reads()).toBe(1);
    expect(h.merges).toHaveLength(0);
  });
});

describe("settled landing PRs are left alone while the fingerprint holds", () => {
  test.each([
    ["BLOCKED, checks done (waiting for approval)", pr(), false],
    [
      "UNSTABLE, red, nothing left to re-run",
      pr({ checks: "failure", mergeStateStatus: "unstable" }),
      false,
    ],
    ["CLEAN on a migration-bearing epic (manual land)", pr({ mergeStateStatus: "clean" }), true],
  ])("%s: one read in 10 min, a re-check at 15 min", async (_name, status, migrations) => {
    // the UNSTABLE case: no failed Actions run to re-run → the re-run pass records it and stops
    const h = makeHarness({ failedRun: null });
    h.setPr(status);
    seedOpenLanding(h);
    if (migrations) h.store.setEpicMigrationPaths(REPO, PARENT, ["migrations/001.sql"]);

    await h.tickUntil(10 * 60_000);
    expect(h.reads()).toBe(1);
    expect(h.merges).toHaveLength(0);
    expect(h.reruns).toHaveLength(0);

    h.setNow(LANDING_PR_RECHECK_MS);
    await h.drain.tick();
    expect(h.reads()).toBe(2);
  });

  test("a moved fingerprint means one fresh read on the next tick", async () => {
    const h = makeHarness();
    seedOpenLanding(h);
    await h.tickUntil(2 * TICK_MS);
    expect(h.reads()).toBe(1);
    h.setKey("k2");
    h.setNow(3 * TICK_MS);
    await h.drain.tick();
    h.setNow(4 * TICK_MS);
    await h.drain.tick();
    expect(h.reads()).toBe(2);
  });

  test("a current open-PR snapshot answers without a per-head lookup", async () => {
    const h = makeHarness();
    seedOpenLanding(h);
    h.setNow(60_000);
    h.setSnapshot({
      at: 50_000,
      value: { prs: [], statuses: new Map([[BRANCH, pr()]]), capped: false },
    });
    await h.drain.tick();
    expect(h.reads()).toBe(0);
  });

  test("pre-warm: an open, settled draft is read once in 10 min", async () => {
    const h = makeHarness({ preWarm: true });
    h.setPr(pr({ isDraft: true, mergeStateStatus: "draft" }));
    h.store.setEpicRun({
      repoPath: REPO,
      parentIssueNumber: PARENT,
      mode: "auto",
      status: "running",
    });
    h.store.recordEpicIntegrated(REPO, PARENT, 320, { number: 9320, url: "https://x/9320" });
    h.store.getOrInitEpicIntegrationBranch(REPO, PARENT, BRANCH);
    const preWarm = h.drain as unknown as {
      landingPrs: { beginTick(): void };
      ensureDraftLandingPrForRepo: (r: string) => Promise<void>;
    };
    for (let t = 0; t <= 10 * 60_000; t += TICK_MS) {
      h.setNow(t);
      preWarm.landingPrs.beginTick();
      await preWarm.ensureDraftLandingPrForRepo(REPO);
    }
    expect(h.reads()).toBe(1);
  });
});

describe("auto-land and the red-CI re-run still fire within one tick", () => {
  test("auto-land: approval moves the fingerprint → merged on that tick", async () => {
    const h = makeHarness();
    seedOpenLanding(h);
    await h.tickUntil(5 * 60_000);
    expect(h.merges).toHaveLength(0);

    h.setPr(pr({ mergeStateStatus: "clean" }));
    h.setKey("k2");
    h.setNow(h.now() + TICK_MS);
    await h.drain.tick();
    expect(h.merges).toEqual([LANDING_PR]);
    expect(row(h).landingState).toBe("merged");
  });

  test("auto-land: CI turns green → merged on that tick", async () => {
    const h = makeHarness();
    h.setPr(pr({ checks: "pending", runningChecks: ["ci / test"] }));
    seedOpenLanding(h);
    await h.tickUntil(2 * TICK_MS);

    h.setPr(pr({ mergeStateStatus: "clean" })); // no fingerprint move: checks don't touch the PR
    h.setNow(3 * TICK_MS);
    await h.drain.tick();
    expect(h.merges).toEqual([LANDING_PR]);
  });

  test("re-run: CI turns red → re-run on that tick; the next tick reads afresh, no second re-run", async () => {
    const h = makeHarness();
    h.setPr(pr({ checks: "pending", runningChecks: ["ci / test"] }));
    seedOpenLanding(h);
    await h.drain.tick();

    h.setPr(pr({ checks: "failure", mergeStateStatus: "unstable" }));
    h.setNow(TICK_MS);
    await h.drain.tick();
    expect(h.reruns).toEqual([42]);

    // GitHub now shows the re-run's pending checks — without moving the PR fingerprint.
    h.setPr(pr({ checks: "pending", runningChecks: ["ci / test"], mergeStateStatus: "unstable" }));
    h.setNow(2 * TICK_MS);
    await h.drain.tick();
    expect(h.reads()).toBe(3);
    expect(h.reruns).toEqual([42]);
    expect(row(h).landingRerunCount).toBe(1);
  });
});

describe("the drain's own writes force a fresh read on the next tick", () => {
  test("a stuck-landing rebase", async () => {
    let n = 0;
    const h = makeHarness({ rebase: async () => ({ kind: "rebased", headSha: `sha-${++n}` }) });
    h.setPr(pr({ mergeStateStatus: "behind" }));
    seedOpenLanding(h);
    await h.tickUntil(2 * TICK_MS);
    expect(h.rebases).toHaveLength(3);
    expect(h.reads()).toBe(3);
  });

  test("a failed merge attempt", async () => {
    const h = makeHarness({ mergeError: "Required status check is expected" });
    h.setPr(pr({ mergeStateStatus: "clean" }));
    seedOpenLanding(h);
    await h.drain.tick();
    expect(h.merges).toHaveLength(1);
    expect(h.reads()).toBe(2); // the tick's read + the live re-read after the failure

    h.setNow(TICK_MS);
    await h.drain.tick(); // a fresh read, then the retried merge fails and re-reads again
    expect(h.merges).toHaveLength(2);
    expect(h.reads()).toBe(4);
  });

  test("a repair-session spawn", async () => {
    const h = makeHarness({ failedRun: null });
    h.setPr(pr({ checks: "failure", mergeStateStatus: "unstable" }));
    seedOpenLanding(h);
    await h.tickUntil(TICK_MS);
    expect(h.reads()).toBe(1); // settled: nothing left to re-run, auto-drain off

    expect(await h.drain.repairLandingCi(REPO, PARENT)).toEqual({ ok: true }); // reads live itself
    expect(h.reads()).toBe(2);
    h.setNow(2 * TICK_MS);
    await h.drain.tick();
    expect(h.reads()).toBe(3);
  });
});
