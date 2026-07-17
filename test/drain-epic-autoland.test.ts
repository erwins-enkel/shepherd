import { test, expect, describe } from "bun:test";
import { DrainService } from "../src/drain";
import { SessionStore } from "../src/store";
import type { GitForge, Issue, MergeInput, PrStatus, SubIssueRef } from "../src/forge/types";
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

/** A ready-to-merge landing PR (clean GitHub mergeStateStatus). Override fields per test. */
function readyPr(over: Partial<PrStatus> = {}): PrStatus {
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
  deleteBranch: boolean | undefined;
}

interface ForgeSpy {
  forge: GitForge;
  mergeCalls: MergeCall[];
  prStatusCalls: string[];
}

function fakeForge(opts: {
  prStatus?: (head: string) => Promise<PrStatus>;
  merge?: (prNumber: number, o: MergeInput) => Promise<void>;
}): ForgeSpy {
  const mergeCalls: MergeCall[] = [];
  const prStatusCalls: string[] = [];
  const forge: GitForge = {
    kind: "github",
    slug: "o/r",
    mergeMethod: "squash",
    deployWorkflow: null,
    listIssues: async () => [],
    listPullRequests: async () => [],
    listBacklogCounts: async () => EMPTY_BACKLOG_COUNTS,
    prStatus: async (head: string) => {
      prStatusCalls.push(head);
      return (
        (await opts.prStatus?.(head)) ??
        ({ state: "none", checks: "none", deployConfigured: false } as PrStatus)
      );
    },
    openPr: async () => ({ state: "open", checks: "none", deployConfigured: false }) as PrStatus,
    defaultBranch: async () => "main",
    merge: async (prNumber: number, o: MergeInput) => {
      mergeCalls.push({ prNumber, method: o.method, deleteBranch: o.deleteBranch });
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
  setNow: (ms: number) => void;
}

function makeHarness(opts: {
  autoMergeEnabled?: boolean;
  draftMode?: boolean;
  prStatus?: (head: string) => Promise<PrStatus>;
  merge?: (prNumber: number, o: MergeInput) => Promise<void>;
  /** Skip pinning the integration branch (models an unpinned row). */
  noPin?: boolean;
}): Harness {
  const store = new SessionStore(":memory:");
  store.setRepoConfig(REPO, {
    criticEnabled: true,
    criticAllPrs: false,
    criticSmellLensEnabled: false,
    autoAddressEnabled: false,
    learningsEnabled: true,
    autopilotEnabled: false,
    planGateEnabled: false,
    autoDrainEnabled: false, // keep pump() gated off → tick() exercises only landing logic
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

  const spy = fakeForge(opts);
  const completedEmits: CompletedEpic[] = [];
  let nowMs = 1_000;

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
    now: () => nowMs,
    rebaseCap: 5,
  });

  return { store, drain, completedEmits, spy, setNow: (ms) => (nowMs = ms) };
}

/** Seed an epic_completed row already in landingState='open' with a pinned integration branch. */
function seedOpenLanding(h: Harness, opts: { migrations?: string[]; pin?: boolean } = {}): void {
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
    // Pin the integration branch (getEpicIntegrationBranch returns null until pinned).
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
}

const row = (h: Harness) => h.store.listEpicCompleted(REPO)[0]!;

describe("auto-land of integrated epics (#1044)", () => {
  test("autoMergeEnabled OFF → ready landing PR is NOT merged", async () => {
    const h = makeHarness({ autoMergeEnabled: false, prStatus: async () => readyPr() });
    seedOpenLanding(h);

    await h.drain.tick();

    expect(h.spy.mergeCalls).toHaveLength(0);
    expect(row(h).landingState).toBe("open");
  });

  test("autoMergeEnabled ON + draftMode ON → suppressed (no merge)", async () => {
    const h = makeHarness({
      autoMergeEnabled: true,
      draftMode: true,
      prStatus: async () => readyPr(),
    });
    seedOpenLanding(h);

    await h.drain.tick();

    expect(h.spy.mergeCalls).toHaveLength(0);
    expect(row(h).landingState).toBe("open");
  });

  test("autoMerge ON, ready, no migrations → merge via host method + row merged + emit", async () => {
    const h = makeHarness({ autoMergeEnabled: true, prStatus: async () => readyPr() });
    seedOpenLanding(h);

    await h.drain.tick();

    expect(h.spy.mergeCalls).toHaveLength(1);
    expect(h.spy.mergeCalls[0]).toEqual({
      prNumber: LANDING_PR,
      method: "squash",
      deleteBranch: true,
    });
    expect(row(h).landingState).toBe("merged");
    expect(h.completedEmits.at(-1)!.landingState).toBe("merged");
  });

  test("migrationPaths non-empty → epic is NEVER auto-landed (manual CTA only)", async () => {
    const h = makeHarness({ autoMergeEnabled: true, prStatus: async () => readyPr() });
    seedOpenLanding(h, { migrations: ["server/migrations/001.sql"] });

    await h.drain.tick();

    expect(h.spy.mergeCalls).toHaveLength(0);
    // NOTE: the rebase pass (#1071) DOES call prStatus for migration-bearing rows because it
    // never merges — keeping them mergeable for the operator's manual ack/land CTA (per plan).
    // The auto-LAND pass still skips them (migrationPaths.length > 0 guard at drain.ts:1147).
    // Only assert that merge was NOT called, not the prStatus call count.
    expect(row(h).landingState).toBe("open");
  });

  test("not ready (checks pending) → no merge, row stays open", async () => {
    const h = makeHarness({
      autoMergeEnabled: true,
      prStatus: async () => readyPr({ checks: "pending" }),
    });
    seedOpenLanding(h);

    await h.drain.tick();

    expect(h.spy.mergeCalls).toHaveLength(0);
    expect(row(h).landingState).toBe("open");
  });

  test("blocked mergeStateStatus → no merge (computeLandingReady false)", async () => {
    const h = makeHarness({
      autoMergeEnabled: true,
      prStatus: async () => readyPr({ mergeStateStatus: "blocked" }),
    });
    seedOpenLanding(h);

    await h.drain.tick();

    expect(h.spy.mergeCalls).toHaveLength(0);
    expect(row(h).landingState).toBe("open");
  });

  test("draft landing PR → no merge (explicit guard)", async () => {
    const h = makeHarness({
      autoMergeEnabled: true,
      // Gitea-style: undefined mergeStateStatus would pass computeLandingReady; the isDraft
      // guard must still block it.
      prStatus: async () => readyPr({ isDraft: true, mergeStateStatus: undefined }),
    });
    seedOpenLanding(h);

    await h.drain.tick();

    expect(h.spy.mergeCalls).toHaveLength(0);
    expect(row(h).landingState).toBe("open");
  });

  test("prStatus throws → fail-closed (no merge), row stays open", async () => {
    const h = makeHarness({
      autoMergeEnabled: true,
      prStatus: async () => {
        throw new Error("forge down");
      },
    });
    seedOpenLanding(h);

    await h.drain.tick();

    expect(h.spy.mergeCalls).toHaveLength(0);
    expect(row(h).landingState).toBe("open");
  });

  test("unpinned integration branch → skip cleanly, no forge call", async () => {
    const h = makeHarness({ autoMergeEnabled: true, prStatus: async () => readyPr() });
    seedOpenLanding(h, { pin: false });

    await h.drain.tick();

    expect(h.spy.prStatusCalls).toHaveLength(0);
    expect(h.spy.mergeCalls).toHaveLength(0);
    expect(row(h).landingState).toBe("open");
  });

  test("prStatus reports merged on an open row → reconcile to merged, no merge call", async () => {
    const h = makeHarness({
      autoMergeEnabled: true,
      prStatus: async () => readyPr({ state: "merged" }),
    });
    seedOpenLanding(h);

    await h.drain.tick();

    expect(h.spy.mergeCalls).toHaveLength(0);
    expect(row(h).landingState).toBe("merged");
    expect(h.completedEmits.at(-1)!.landingState).toBe("merged");
  });

  test("prStatus reports closed on an open row → reconcile to none, not re-polled next tick", async () => {
    const h = makeHarness({
      autoMergeEnabled: true,
      prStatus: async () => readyPr({ state: "closed" }),
    });
    seedOpenLanding(h);

    await h.drain.tick();
    expect(h.spy.mergeCalls).toHaveLength(0);
    expect(row(h).landingState).toBe("none");
    const pollsAfterFirst = h.spy.prStatusCalls.length;

    // Second tick: row is terminal 'none' → never a candidate → no further prStatus.
    await h.drain.tick();
    expect(h.spy.prStatusCalls.length).toBe(pollsAfterFirst);
  });

  test("merge throws (real failure) → row stays open; per-head cap backs off; new head clears", async () => {
    // console.warn expected on each merge failure.
    let head = "head-A";
    const h = makeHarness({
      autoMergeEnabled: true,
      prStatus: async () => readyPr({ headSha: head }),
      merge: async () => {
        throw new Error("merge 500");
      },
    });
    seedOpenLanding(h);

    // 3 failing ticks → at the cap, backed off.
    for (let i = 0; i < 3; i++) await h.drain.tick();
    expect(h.spy.mergeCalls.length).toBe(3);
    expect(row(h).landingState).toBe("open");

    // 4th tick within the backoff window on the SAME head → no new merge attempt.
    await h.drain.tick();
    expect(h.spy.mergeCalls.length).toBe(3);

    // A NEW head clears the backoff → merge is attempted again.
    head = "head-B";
    await h.drain.tick();
    expect(h.spy.mergeCalls.length).toBe(4);
  });

  test("backoff window expiry → retry allowed after the window elapses", async () => {
    // console.warn expected on each merge failure.
    const h = makeHarness({
      autoMergeEnabled: true,
      prStatus: async () => readyPr(),
      merge: async () => {
        throw new Error("merge 500");
      },
    });
    seedOpenLanding(h);

    for (let i = 0; i < 3; i++) await h.drain.tick();
    expect(h.spy.mergeCalls.length).toBe(3);

    await h.drain.tick(); // still inside window → suppressed
    expect(h.spy.mergeCalls.length).toBe(3);

    h.setNow(1_000 + 600_000); // advance past the 300s backoff window
    await h.drain.tick();
    expect(h.spy.mergeCalls.length).toBe(4);
  });

  test("already-merged merge error → reconciled to merged, NOT counted as a failure", async () => {
    // The lost manual-vs-auto race: the ready-check sees the PR open, but by the time forge.merge
    // fires a concurrent manual land already merged it → merge rejects, and a re-read now reports
    // merged. The failure path must reconcile (→ merged), never arm the backoff.
    //
    // With the #1071 rebase pass also running each tick, prStatus is read once more (the rebase
    // pass sees an open+clean PR → not stuck → skips rebase). Auto-land then reads on the NEXT
    // call and gets a ready PR → attempts merge → it throws "already merged" → re-reads → merged.
    let reads = 0;
    const h = makeHarness({
      autoMergeEnabled: true,
      prStatus: async () => {
        reads++;
        // reads 1: rebase pass (not-stuck, skips); reads 2: auto-land ready-check; reads 3+: post-merge re-check.
        return reads <= 2 ? readyPr() : readyPr({ state: "merged" });
      },
      merge: async () => {
        throw new Error("Pull request is not mergeable: already merged");
      },
    });
    seedOpenLanding(h);

    await h.drain.tick();

    expect(h.spy.mergeCalls).toHaveLength(1); // we did attempt the merge
    expect(row(h).landingState).toBe("merged"); // …but reconciled to merged, not error/open
    expect(h.completedEmits.at(-1)!.landingState).toBe("merged");
  });
});
