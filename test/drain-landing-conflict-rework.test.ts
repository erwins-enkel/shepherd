/**
 * #1841 item 2 — conflict-rework dispatch for a conflict-paused epic landing PR.
 *
 * When the drain's auto-rebase hits a genuine (non-union) conflict the landing row is paused with
 * `landingRebasePauseReason: "conflict"`. The stuck-landing pass now auto-dispatches ONE capped
 * `landingRepair` session (LANDING_CONFLICT_REWORK_CAP=1, durable via landingConflictReworkCount —
 * NOT the CI-repair budget) that rebases the integration branch onto the default branch, resolves,
 * and force-with-lease pushes. The operator's manual "Resolve conflicts" (resolveLandingConflict)
 * bypasses auto-drain + the cap, but is still refused while a live repair session holds the branch.
 */
import { test, expect, describe } from "bun:test";
import { DrainService } from "../src/drain";
import { SessionStore } from "../src/store";
import type { GitForge, Issue, PrStatus, SubIssueRef } from "../src/forge/types";
import { EMPTY_BACKLOG_COUNTS } from "../src/forge/types";
import type { UsageLimits as UsageLimitsType } from "../src/usage-limits";
import type { NotifyInput } from "../src/push";
import type { StandardCreateInput } from "../src/types";
import { epicIntegrationBranch } from "../src/epic-branch";

const REPO = "/repo";
const PARENT = 412;
const PARENT_TITLE = "Payments rework";
const BRANCH = epicIntegrationBranch(PARENT, PARENT_TITLE);
const LANDING_PR = 777;

const NO_USAGE: UsageLimitsType = {
  session5h: null,
  week: null,
  perModelWeek: [],
  credits: null,
  stale: false,
  calibratedAt: null,
  subscriptionOnly: false,
};

/** A landing PR GitHub reports as conflicting with the default branch. */
function conflictingPr(over: Partial<PrStatus> = {}): PrStatus {
  return {
    state: "open",
    number: LANDING_PR,
    url: `https://github.com/o/r/pull/${LANDING_PR}`,
    checks: "success",
    mergeable: false,
    mergeStateStatus: "dirty",
    headSha: "c1",
    isDraft: false,
    deployConfigured: false,
    ...over,
  };
}

function fakeForge(prStatus: () => PrStatus, kind: GitForge["kind"] = "github"): GitForge {
  return {
    kind,
    slug: "o/r",
    mergeMethod: "squash",
    deployWorkflow: null,
    listIssues: async () => [],
    listPullRequests: async () => [],
    listBacklogCounts: async () => EMPTY_BACKLOG_COUNTS,
    prStatus: async () => prStatus(),
    openPr: async () => ({ state: "open", checks: "none", deployConfigured: false }) as PrStatus,
    defaultBranch: async () => "main",
    merge: async () => {},
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
}

interface Harness {
  store: SessionStore;
  drain: DrainService;
  creates: StandardCreateInput[];
  rebaseSeamCalls: () => number;
  setPr: (pr: PrStatus) => void;
  clock: { t: number };
  notifies: NotifyInput[];
  sessionNews: unknown[];
}

function makeHarness(
  opts: {
    autoDrainEnabled?: boolean;
    autoMergeEnabled?: boolean;
    createThrows?: boolean;
    capacity?: boolean;
    forgeKind?: GitForge["kind"];
  } = {},
): Harness {
  const store = new SessionStore(":memory:");
  store.setRepoConfig(REPO, {
    criticEnabled: false,
    criticAllPrs: false,
    criticSmellLensEnabled: false,
    autoAddressEnabled: false,
    learningsEnabled: false,
    autopilotEnabled: false,
    planGateEnabled: false,
    autoDrainEnabled: opts.autoDrainEnabled ?? true,
    autoMergeEnabled: opts.autoMergeEnabled ?? false,
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
    preWarmEpicLandingCi: false,
    epicStacksEnabled: false,
    sharedBrowserEnabled: false,
    browserAllowedHosts: [],
    hidden: false,
  });
  let pr = conflictingPr();
  let rebaseCalls = 0;
  const creates: StandardCreateInput[] = [];
  const forge = fakeForge(() => pr, opts.forgeKind);
  const clock = { t: 1_000_000 };
  const notifies: NotifyInput[] = [];
  const sessionNews: unknown[] = [];
  const drain = new DrainService({
    store,
    service: {
      create: async (input: StandardCreateInput) => {
        creates.push(input);
        if (opts.createThrows) throw new Error("spawn refused");
        return { id: "rework-sess", baseBranch: input.baseBranch } as never;
      },
      archive: () => 1,
    } as never,
    resolveForge: () => forge,
    prCache: { snapshot: () => ({}) },
    usage: { limits: (): UsageLimitsType => NO_USAGE },
    repos: () => [REPO],
    emitStatus: () => {},
    emitArchived: () => {},
    dropPrCache: () => {},
    emitEpic: () => {},
    emitEpicCompleted: () => {},
    emitSessionNew: (s) => sessionNews.push(s),
    readCodexAuthMode: () => "unknown",
    notify: async (n: NotifyInput) => {
      notifies.push(n);
      return true;
    },
    now: () => clock.t,
    rebaseCap: 5,
    rebaseLandingBranch: async () => {
      rebaseCalls += 1;
      return { kind: "conflict" };
    },
    ...(opts.capacity === false ? { capacity: async () => false } : {}),
  });
  return {
    store,
    drain,
    creates,
    rebaseSeamCalls: () => rebaseCalls,
    setPr: (p) => {
      pr = p;
    },
    clock,
    notifies,
    sessionNews,
  };
}

/** Seed an open landing row, pinned integration branch, conflict-paused. */
function seedConflictPaused(h: Harness, pause: "conflict" | null = "conflict"): void {
  h.store.recordEpicCompleted({
    repoPath: REPO,
    parentIssueNumber: PARENT,
    parentTitle: PARENT_TITLE,
    completedAt: 1,
    childrenJson: "[]",
  });
  h.store.getOrInitEpicIntegrationBranch(REPO, PARENT, BRANCH);
  h.store.setEpicLandingPr(REPO, PARENT, {
    state: "open",
    prNumber: LANDING_PR,
    prUrl: `https://github.com/o/r/pull/${LANDING_PR}`,
    attempts: 0,
  });
  h.store.setEpicLandingRebaseState(REPO, PARENT, { pauseReason: pause });
}

function addLiveRepairSession(h: Harness): void {
  h.store.create({
    name: "repair",
    prompt: "repair",
    repoPath: REPO,
    baseBranch: BRANCH,
    branch: BRANCH,
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t",
    auto: true,
    landingRepair: true,
  });
}

function row(h: Harness) {
  return h.store.listEpicCompleted(REPO).find((r) => r.parentIssueNumber === PARENT)!;
}

function tickStuckPass(h: Harness): Promise<void> {
  const drain = h.drain as unknown as {
    landingPrs: { beginTick(): void };
    rebaseStuckLandingPrsForRepo: (r: string) => Promise<void>;
  };
  drain.landingPrs.beginTick(); // each call stands for its own drain tick (#2873)
  return drain.rebaseStuckLandingPrsForRepo(REPO);
}

describe("conflict rework: auto dispatch (drain tick)", () => {
  test("conflict pause + still conflicting → ONE landingRepair session with the conflict prompt", async () => {
    const h = makeHarness();
    seedConflictPaused(h);

    await tickStuckPass(h);

    expect(h.creates).toHaveLength(1);
    const input = h.creates[0]!;
    expect(input.landingRepair).toBe(true);
    expect(input.baseBranch).toBe(BRANCH);
    expect(input.auto).toBe(true);
    expect(input.issueRef).toBeUndefined();
    expect(input.prompt).toContain("git fetch origin");
    expect(input.prompt).toContain("git rebase origin/main");
    expect(input.prompt).toContain(
      `git push --force-with-lease=${BRANCH}:<lease-sha> origin HEAD:${BRANCH}`,
    );
    expect(input.prompt).toContain("Do NOT open a pull request");
    // Its own budget: conflict counter bumped, CI-repair budget untouched.
    expect(row(h).landingConflictReworkCount).toBe(1);
    expect(row(h).landingRepairCount).toBe(0);
    // Never re-runs the auto-rebase that just conflicted.
    expect(h.rebaseSeamCalls()).toBe(0);
    // Pushed to the UI live.
    expect(h.sessionNews).toEqual([{ id: "rework-sess", baseBranch: BRANCH }]);
  });

  test("second tick while still conflicting → no new spawn (auto cap 1)", async () => {
    const h = makeHarness();
    seedConflictPaused(h);

    await tickStuckPass(h);
    await tickStuckPass(h);

    expect(h.creates).toHaveLength(1);
    expect(row(h).landingConflictReworkCount).toBe(1);
  });

  test("autoDrain off (engaged via autoMerge) → no spawn", async () => {
    const h = makeHarness({ autoDrainEnabled: false, autoMergeEnabled: true });
    seedConflictPaused(h);

    await tickStuckPass(h);

    expect(h.creates).toHaveLength(0);
    expect(row(h).landingConflictReworkCount).toBe(0);
  });

  test("cap already spent → no spawn", async () => {
    const h = makeHarness();
    seedConflictPaused(h);
    h.store.setEpicLandingConflictReworkCount(REPO, PARENT, 1);

    await tickStuckPass(h);

    expect(h.creates).toHaveLength(0);
  });

  test("live repair session holds the branch → no spawn", async () => {
    const h = makeHarness();
    seedConflictPaused(h);
    addLiveRepairSession(h);

    await tickStuckPass(h);

    expect(h.creates).toHaveLength(0);
    expect(row(h).landingConflictReworkCount).toBe(0);
  });

  test("spawn refusal → counter NOT bumped, cooldown suppresses the immediate retry", async () => {
    const h = makeHarness({ createThrows: true });
    seedConflictPaused(h);

    await tickStuckPass(h);
    await tickStuckPass(h);

    expect(h.creates).toHaveLength(1);
    expect(row(h).landingConflictReworkCount).toBe(0);
  });

  test("capacity refusal → no create, counter NOT bumped", async () => {
    const h = makeHarness({ capacity: false });
    seedConflictPaused(h);

    await tickStuckPass(h);

    expect(h.creates).toHaveLength(0);
    expect(row(h).landingConflictReworkCount).toBe(0);
  });

  test("conflict resolved (PR no longer conflicting) → pause cleared, no rework spawn", async () => {
    const h = makeHarness();
    seedConflictPaused(h);
    h.setPr(conflictingPr({ mergeable: true, mergeStateStatus: "clean" }));

    await tickStuckPass(h);

    expect(row(h).landingRebasePauseReason).toBeNull();
    expect(h.creates).toHaveLength(0);
  });

  test("not paused → normal rebase path, no rework spawn", async () => {
    const h = makeHarness();
    seedConflictPaused(h, null);

    await tickStuckPass(h);

    expect(h.rebaseSeamCalls()).toBe(1);
    expect(h.creates).toHaveLength(0);
    // The fake seam reports a conflict → row enters the pause; rework waits for the next tick.
    expect(row(h).landingRebasePauseReason).toBe("conflict");
  });
});

describe("conflict rework: manual resolveLandingConflict", () => {
  test("bypasses autoDrain off AND a spent cap → spawns, counter bumped", async () => {
    const h = makeHarness({ autoDrainEnabled: false });
    seedConflictPaused(h);
    h.store.setEpicLandingConflictReworkCount(REPO, PARENT, 1);

    const r = await h.drain.resolveLandingConflict(REPO, PARENT);

    expect(r).toEqual({ ok: true });
    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]!.landingRepair).toBe(true);
    expect(row(h).landingConflictReworkCount).toBe(2);
    expect(row(h).landingRepairCount).toBe(0);
    expect(h.sessionNews).toEqual([{ id: "rework-sess", baseBranch: BRANCH }]);
  });

  test("refused while a live repair session holds the branch", async () => {
    const h = makeHarness();
    seedConflictPaused(h);
    addLiveRepairSession(h);

    expect(await h.drain.resolveLandingConflict(REPO, PARENT)).toEqual({
      ok: false,
      error: "repairing",
    });
    expect(h.creates).toHaveLength(0);
  });

  test("PR not conflicting → not-conflicting", async () => {
    const h = makeHarness();
    seedConflictPaused(h, null);
    h.setPr(conflictingPr({ mergeable: true, mergeStateStatus: "clean" }));

    expect(await h.drain.resolveLandingConflict(REPO, PARENT)).toEqual({
      ok: false,
      error: "not-conflicting",
    });
    expect(h.creates).toHaveLength(0);
  });

  test("mergeable still computing (null) but row conflict-paused → dispatches", async () => {
    const h = makeHarness();
    seedConflictPaused(h);
    h.setPr(conflictingPr({ mergeable: null }));

    expect(await h.drain.resolveLandingConflict(REPO, PARENT)).toEqual({ ok: true });
  });

  test("no completed row → no-landing", async () => {
    const h = makeHarness();

    expect(await h.drain.resolveLandingConflict(REPO, PARENT)).toEqual({
      ok: false,
      error: "no-landing",
    });
  });

  test("landing PR closed on the forge → no-landing", async () => {
    const h = makeHarness();
    seedConflictPaused(h);
    h.setPr(conflictingPr({ state: "closed" }));

    expect(await h.drain.resolveLandingConflict(REPO, PARENT)).toEqual({
      ok: false,
      error: "no-landing",
    });
  });

  test("non-GitHub forge → unsupported", async () => {
    const h = makeHarness({ forgeKind: "gitea" });
    seedConflictPaused(h);

    expect(await h.drain.resolveLandingConflict(REPO, PARENT)).toEqual({
      ok: false,
      error: "unsupported",
    });
  });

  test("spawn throws → spawn-failed, counter NOT bumped; manual retry ignores the back-off", async () => {
    const h = makeHarness({ createThrows: true });
    seedConflictPaused(h);

    expect(await h.drain.resolveLandingConflict(REPO, PARENT)).toEqual({
      ok: false,
      error: "spawn-failed",
    });
    expect(await h.drain.resolveLandingConflict(REPO, PARENT)).toEqual({
      ok: false,
      error: "spawn-failed",
    });
    expect(h.creates).toHaveLength(2);
    expect(row(h).landingConflictReworkCount).toBe(0);
    expect(h.sessionNews).toHaveLength(0);
  });
});

describe("conflict pause: stale re-escalation (#1841)", () => {
  const H = 60 * 60_000;
  const STALE = 6 * H;

  /** Conflict-paused at the harness clock, rework budget already spent (no auto dispatch). */
  function seedSpent(h: Harness): void {
    seedConflictPaused(h, null);
    h.store.setEpicLandingRebaseState(REPO, PARENT, { pauseReason: "conflict", now: h.clock.t });
    h.store.setEpicLandingConflictReworkCount(REPO, PARENT, 1);
  }

  test("no re-push while the pause is ≤6h old", async () => {
    const h = makeHarness();
    seedSpent(h);
    h.clock.t += STALE;
    await tickStuckPass(h);
    expect(h.notifies).toHaveLength(0);
    expect(row(h).landingConflictEscalatedAt).toBeNull();
  });

  test(">6h → ONE stale landing_conflict push with the age; none again within 6h; again after", async () => {
    const h = makeHarness();
    seedSpent(h);
    h.clock.t += STALE + 1;
    await tickStuckPass(h);
    expect(h.notifies).toHaveLength(1);
    expect(h.notifies[0]).toMatchObject({
      kind: "landing_conflict",
      epicNumber: PARENT,
      landingPr: LANDING_PR,
      staleHours: 6,
      cooldownKey: `landing_conflict_stale:${REPO}#${PARENT}`,
    });
    expect(row(h).landingConflictEscalatedAt).toBe(h.clock.t);

    h.clock.t += STALE;
    await tickStuckPass(h);
    expect(h.notifies).toHaveLength(1);

    h.clock.t += 1;
    await tickStuckPass(h);
    expect(h.notifies).toHaveLength(2);
    expect(h.notifies[1]!.staleHours).toBe(12);
  });

  test("a live repair/rework session suppresses the re-push", async () => {
    const h = makeHarness();
    seedSpent(h);
    addLiveRepairSession(h);
    h.clock.t += STALE + 1;
    await tickStuckPass(h);
    expect(h.notifies).toHaveLength(0);
  });

  test("a rework dispatched this tick suppresses the re-push", async () => {
    const h = makeHarness();
    seedConflictPaused(h, null);
    h.store.setEpicLandingRebaseState(REPO, PARENT, { pauseReason: "conflict", now: h.clock.t });
    h.clock.t += STALE + 1;
    await tickStuckPass(h);
    expect(h.creates).toHaveLength(1);
    expect(h.notifies).toHaveLength(0);
  });

  test("legacy conflict row without a since-stamp is stamped now, escalates one window later", async () => {
    const h = makeHarness();
    seedSpent(h);
    // Simulate a pre-#1841 row: pause set, no stamp.
    (h.store as unknown as { db: { run: (q: string) => void } }).db.run(
      "UPDATE epic_completed SET landingConflictSince = NULL",
    );
    await tickStuckPass(h);
    expect(row(h).landingConflictSince).toBe(h.clock.t);
    expect(h.notifies).toHaveLength(0);
    h.clock.t += STALE + 1;
    await tickStuckPass(h);
    expect(h.notifies).toHaveLength(1);
  });

  test("resolving the conflict clears both stamps", async () => {
    const h = makeHarness();
    seedSpent(h);
    h.clock.t += STALE + 1;
    await tickStuckPass(h);
    expect(row(h).landingConflictEscalatedAt).not.toBeNull();
    h.setPr({ ...conflictingPr(), mergeable: true, mergeStateStatus: "clean", checks: "success" });
    await tickStuckPass(h);
    expect(row(h).landingRebasePauseReason).toBeNull();
    expect(row(h).landingConflictSince).toBeNull();
    expect(row(h).landingConflictEscalatedAt).toBeNull();
  });
});
