/**
 * Tests for the (C) drain-tick pass — `rerunRedLandingCiForRepo` in drain.ts.
 *
 * Auto-reruns the failed CI on a red epic landing PR (flake absorption), capped per head SHA.
 * GitHub-only; never merges. Runs between rebaseStuckLandingPrsForRepo and autoLandLandingPrsForRepo.
 */
import { test, expect, describe } from "bun:test";
import { DrainService } from "../src/drain";
import { SessionStore } from "../src/store";
import type { GitForge, Issue, PrStatus, SubIssueRef } from "../src/forge/types";
import { EMPTY_BACKLOG_COUNTS } from "../src/forge/types";
import type { UsageLimits as UsageLimitsType } from "../src/usage-limits";
import type { CompletedEpic } from "../src/completed-epic";
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

/** A red (terminally failed CI), otherwise-landable PR — the target of this pass. */
function redPr(over: Partial<PrStatus> = {}): PrStatus {
  return {
    state: "open",
    number: LANDING_PR,
    url: `https://github.com/o/r/pull/${LANDING_PR}`,
    checks: "failure",
    mergeable: true,
    mergeStateStatus: "clean",
    headSha: "h1",
    isDraft: false,
    deployConfigured: false,
    ...over,
  };
}

interface RerunCall {
  runId: number;
  failedOnly: boolean;
}

interface ForgeSpy {
  forge: GitForge;
  prStatusCalls: string[];
  rerunCalls: RerunCall[];
  latestFailedRunCalls: number[];
}

function fakeForge(opts: {
  kind?: "github" | "gitea" | "local";
  prStatus?: (branch: string) => Promise<PrStatus>;
  latestFailedRunForPr?: (prNumber: number) => Promise<number | null>;
  /** When false, omit rerunWorkflowRun/latestFailedRunForPr entirely (capability-missing case). */
  hasRerunCapability?: boolean;
}): ForgeSpy {
  const prStatusCalls: string[] = [];
  const rerunCalls: RerunCall[] = [];
  const latestFailedRunCalls: number[] = [];
  const hasCap = opts.hasRerunCapability ?? true;

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
    merge: async () => {
      throw new Error("merge should never be called by the rerun pass");
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
    ...(hasCap
      ? {
          latestFailedRunForPr: async (prNumber: number) => {
            latestFailedRunCalls.push(prNumber);
            return (await opts.latestFailedRunForPr?.(prNumber)) ?? null;
          },
          rerunWorkflowRun: async (runId: number, o: { failedOnly: boolean }) => {
            rerunCalls.push({ runId, failedOnly: o.failedOnly });
          },
        }
      : {}),
  };
  return { forge, prStatusCalls, rerunCalls, latestFailedRunCalls };
}

interface Harness {
  store: SessionStore;
  drain: DrainService;
  completedEmits: CompletedEpic[];
  spy: ForgeSpy;
}

function makeHarness(opts: {
  autoMergeEnabled?: boolean;
  autoDrainEnabled?: boolean;
  epicRunning?: boolean;
  draftMode?: boolean;
  prStatus?: (branch: string) => Promise<PrStatus>;
  latestFailedRunForPr?: (prNumber: number) => Promise<number | null>;
  /** When false, use a gitea forge (non-github). */
  github?: boolean;
  hasRerunCapability?: boolean;
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
    latestFailedRunForPr: opts.latestFailedRunForPr,
    hasRerunCapability: opts.hasRerunCapability,
  });
  const completedEmits: CompletedEpic[] = [];

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
    rebaseCap: 5,
    rebaseLandingBranch: async () => ({ kind: "current" }),
  });

  return { store, drain, completedEmits, spy };
}

/** Seed an `epic_completed` row with landingState='open' and a pinned integration branch. */
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
  h.store.getOrInitEpicIntegrationBranch(REPO, PARENT, INTEGRATION_BRANCH);
  h.store.setEpicLandingPr(REPO, PARENT, {
    state: "open",
    prNumber: LANDING_PR,
    prUrl: `https://github.com/o/r/pull/${LANDING_PR}`,
    attempts: 0,
  });
}

/** Invoke the private rerun pass directly so prStatus/rerun call counts are isolated to it
 *  (tick() also runs rebaseStuckLandingPrsForRepo and autoLandLandingPrsForRepo, which read prStatus). */
function callRerunPass(h: Harness): Promise<void> {
  return (
    h.drain as unknown as { rerunRedLandingCiForRepo: (repoPath: string) => Promise<void> }
  ).rerunRedLandingCiForRepo(REPO);
}

describe("rerunRedLandingCiForRepo (C)", () => {
  // ── gate tests ──────────────────────────────────────────────────────────────

  test("gate-off: draftMode ON → rerunWorkflowRun NOT called", async () => {
    const h = makeHarness({
      draftMode: true,
      autoMergeEnabled: true,
      prStatus: async () => redPr(),
      latestFailedRunForPr: async () => 42,
    });
    seedOpenLanding(h);

    await callRerunPass(h);

    expect(h.spy.rerunCalls).toHaveLength(0);
    expect(h.spy.prStatusCalls).toHaveLength(0);
  });

  test("gate-off: autoMerge+autoDrain off, no running epic → rerunWorkflowRun NOT called", async () => {
    const h = makeHarness({
      autoMergeEnabled: false,
      autoDrainEnabled: false,
      prStatus: async () => redPr(),
      latestFailedRunForPr: async () => 42,
    });
    seedOpenLanding(h);

    await callRerunPass(h);

    expect(h.spy.rerunCalls).toHaveLength(0);
    expect(h.spy.prStatusCalls).toHaveLength(0);
  });

  test("gate: autoMergeEnabled ON (autoDrain off, no epic) → pass runs", async () => {
    const h = makeHarness({
      autoMergeEnabled: true,
      autoDrainEnabled: false,
      prStatus: async () => redPr(),
      latestFailedRunForPr: async () => 42,
    });
    seedOpenLanding(h);

    await callRerunPass(h);

    expect(h.spy.rerunCalls).toHaveLength(1);
  });

  test("gate: autoDrainEnabled ON (autoMerge off, no epic) → pass runs", async () => {
    const h = makeHarness({
      autoMergeEnabled: false,
      autoDrainEnabled: true,
      prStatus: async () => redPr(),
      latestFailedRunForPr: async () => 42,
    });
    seedOpenLanding(h);

    await callRerunPass(h);

    expect(h.spy.rerunCalls).toHaveLength(1);
  });

  test("epic-running engages: autoMerge+autoDrain off but epic status=running → pass runs", async () => {
    const h = makeHarness({
      autoMergeEnabled: false,
      autoDrainEnabled: false,
      epicRunning: true,
      prStatus: async () => redPr(),
      latestFailedRunForPr: async () => 42,
    });
    seedOpenLanding(h);

    await callRerunPass(h);

    expect(h.spy.rerunCalls).toHaveLength(1);
  });

  test("non-github forge (gitea) → NOT called, zero prStatus calls", async () => {
    const h = makeHarness({
      autoMergeEnabled: true,
      github: false,
      prStatus: async () => redPr(),
      latestFailedRunForPr: async () => 42,
    });
    seedOpenLanding(h);

    await callRerunPass(h);

    expect(h.spy.rerunCalls).toHaveLength(0);
    expect(h.spy.prStatusCalls).toHaveLength(0);
  });

  test("forge missing rerunWorkflowRun/latestFailedRunForPr capability → NOT called", async () => {
    const h = makeHarness({
      autoMergeEnabled: true,
      hasRerunCapability: false,
      prStatus: async () => redPr(),
    });
    seedOpenLanding(h);

    await callRerunPass(h);

    expect(h.spy.rerunCalls).toHaveLength(0);
    expect(h.spy.prStatusCalls).toHaveLength(0);
  });

  // ── core behavior ─────────────────────────────────────────────────────────

  test("reruns a flaky red: terminal failure + mergeable + clean → rerunWorkflowRun(runId, {failedOnly:true})", async () => {
    const h = makeHarness({
      autoMergeEnabled: true,
      prStatus: async () => redPr(),
      latestFailedRunForPr: async () => 42,
    });
    seedOpenLanding(h);

    await callRerunPass(h);

    expect(h.spy.latestFailedRunCalls).toEqual([LANDING_PR]);
    expect(h.spy.rerunCalls).toEqual([{ runId: 42, failedOnly: true }]);
  });

  // ── per-head cap ────────────────────────────────────────────────────────────

  test("per-head cap: after LANDING_RERUN_CAP reruns on head h1, further passes stop; a NEW head resets", async () => {
    const CAP = 2;
    let head = "h1";
    const h = makeHarness({
      autoMergeEnabled: true,
      prStatus: async () => redPr({ headSha: head }),
      latestFailedRunForPr: async () => 42,
    });
    seedOpenLanding(h);

    for (let i = 0; i < CAP; i++) {
      await callRerunPass(h);
    }
    expect(h.spy.rerunCalls).toHaveLength(CAP);

    // Still h1, budget spent → no rerun.
    await callRerunPass(h);
    expect(h.spy.rerunCalls).toHaveLength(CAP);

    // Head advances (new push) → budget resets.
    head = "h2";
    await callRerunPass(h);
    expect(h.spy.rerunCalls).toHaveLength(CAP + 1);
  });

  test("bounded map: successive heads on one landing keep a SINGLE per-parent entry (not one per head)", async () => {
    let head = "h1";
    const h = makeHarness({
      autoMergeEnabled: true,
      prStatus: async () => redPr({ headSha: head }),
      latestFailedRunForPr: async () => 42,
    });
    seedOpenLanding(h);

    for (const nextHead of ["h1", "h2", "h3"]) {
      head = nextHead;
      await callRerunPass(h);
    }

    // The old per-head-SHA keying grew one entry per head (would be 3 here) and never evicted; the
    // per-`repoPath#parent` keying self-replaces on each new head, so the map stays bounded to live
    // epics. This is the regression guard for the unbounded-growth finding.
    const map = (h.drain as unknown as { landingRerunCount: Map<string, unknown> })
      .landingRerunCount;
    expect(map.size).toBe(1);
  });

  // ── skip cases (no rerun) ────────────────────────────────────────────────────

  test("skips: mergeStateStatus=behind (rebase pass's territory)", async () => {
    const h = makeHarness({
      autoMergeEnabled: true,
      prStatus: async () => redPr({ mergeStateStatus: "behind" }),
      latestFailedRunForPr: async () => 42,
    });
    seedOpenLanding(h);

    await callRerunPass(h);

    expect(h.spy.rerunCalls).toHaveLength(0);
  });

  test("skips: mergeable=false (conflict, rebase pass's territory)", async () => {
    const h = makeHarness({
      autoMergeEnabled: true,
      prStatus: async () => redPr({ mergeable: false }),
      latestFailedRunForPr: async () => 42,
    });
    seedOpenLanding(h);

    await callRerunPass(h);

    expect(h.spy.rerunCalls).toHaveLength(0);
  });

  test("skips: isDraft=true", async () => {
    const h = makeHarness({
      autoMergeEnabled: true,
      prStatus: async () => redPr({ isDraft: true }),
      latestFailedRunForPr: async () => 42,
    });
    seedOpenLanding(h);

    await callRerunPass(h);

    expect(h.spy.rerunCalls).toHaveLength(0);
  });

  test("skips: checks=success (nothing to rerun)", async () => {
    const h = makeHarness({
      autoMergeEnabled: true,
      prStatus: async () => redPr({ checks: "success" }),
      latestFailedRunForPr: async () => 42,
    });
    seedOpenLanding(h);

    await callRerunPass(h);

    expect(h.spy.rerunCalls).toHaveLength(0);
  });

  test("skips: checks=pending (nothing to rerun)", async () => {
    const h = makeHarness({
      autoMergeEnabled: true,
      prStatus: async () => redPr({ checks: "pending" }),
      latestFailedRunForPr: async () => 42,
    });
    seedOpenLanding(h);

    await callRerunPass(h);

    expect(h.spy.rerunCalls).toHaveLength(0);
  });

  test("skips: latestFailedRunForPr resolves null (fork-origin PR / no resolvable run)", async () => {
    const h = makeHarness({
      autoMergeEnabled: true,
      prStatus: async () => redPr(),
      latestFailedRunForPr: async () => null,
    });
    seedOpenLanding(h);

    await callRerunPass(h);

    expect(h.spy.rerunCalls).toHaveLength(0);
  });

  // ── never-merges ─────────────────────────────────────────────────────────────

  test("never merges: forge.merge is never invoked by this pass", async () => {
    const h = makeHarness({
      autoMergeEnabled: true,
      prStatus: async () => redPr(),
      latestFailedRunForPr: async () => 42,
    });
    seedOpenLanding(h);

    // merge() throws in the fake forge if ever called — a clean pass proves it wasn't.
    await expect(callRerunPass(h)).resolves.toBeUndefined();
  });
});
