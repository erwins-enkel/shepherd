import { test, expect, describe } from "bun:test";
import { DrainService } from "../src/drain";
import { SessionStore } from "../src/store";
import type { GitForge, GitState, Issue, PrStatus, SubIssueRef } from "../src/forge/types";
import { EMPTY_BACKLOG_COUNTS } from "../src/forge/types";
import type { UsageLimits as UsageLimitsType } from "../src/usage-limits";

const REPO = "/repo";
const PARENT = 128;
const PINNED = "epic/128-feat-review";
const ACTIVE_LABEL = "shepherd:active";

const NO_USAGE: UsageLimitsType = {
  session5h: null,
  week: null,
  perModelWeek: [],
  credits: null,
  stale: false,
  calibratedAt: null,
  subscriptionOnly: false,
};

function sub(number: number, closed: boolean, claimed = false): SubIssueRef {
  return {
    number,
    title: `child ${number}`,
    url: `https://x/${number}`,
    body: "",
    closed,
    labels: claimed ? [ACTIVE_LABEL] : [],
  };
}

interface Harness {
  store: SessionStore;
  drain: DrainService;
  /** branch → PrStatus (or a thrower); branches without an entry resolve state:"none". */
  prByBranch: Map<string, PrStatus | (() => never)>;
  /** Every branch prStatus was called with, in order. */
  prStatusCalls: string[];
  closeIssueCalls: number[];
  archiveCalls: string[];
  prSnap: Record<string, GitState>;
  clock: { now: number };
}

function makeHarness(opts: {
  subIssues: SubIssueRef[];
  epicStatus?: "running" | "paused" | null;
}): Harness {
  const store = new SessionStore(":memory:");
  store.setRepoConfig(REPO, {
    criticEnabled: false,
    criticAllPrs: false,
    autoAddressEnabled: false,
    learningsEnabled: true,
    autopilotEnabled: false,
    planGateEnabled: false,
    autoDrainEnabled: true,
    autoMergeEnabled: false,
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
    hidden: false,
  });
  if (opts.epicStatus !== null) {
    store.setEpicRun({
      repoPath: REPO,
      parentIssueNumber: PARENT,
      mode: "auto",
      status: opts.epicStatus ?? "running",
    });
    // Pin explicitly so tests control the exact integration-branch name.
    store.getOrInitEpicIntegrationBranch(REPO, PARENT, PINNED);
  }

  const prByBranch = new Map<string, PrStatus | (() => never)>();
  const prStatusCalls: string[] = [];
  const closeIssueCalls: number[] = [];
  const archiveCalls: string[] = [];
  const prSnap: Record<string, GitState> = {};
  const clock = { now: 1_000_000 };

  const forge: GitForge = {
    kind: "github",
    slug: "o/r",
    mergeMethod: "squash",
    deployWorkflow: null,
    listIssues: async () => [],
    listPullRequests: async () => [],
    listBacklogCounts: async () => EMPTY_BACKLOG_COUNTS,
    prStatus: async (branch: string): Promise<PrStatus> => {
      prStatusCalls.push(branch);
      const hit = prByBranch.get(branch);
      if (typeof hit === "function") return hit();
      return hit ?? ({ state: "none", checks: "none", deployConfigured: false } as PrStatus);
    },
    openPr: async () =>
      ({
        state: "open",
        number: 999,
        url: "https://x/pull/999",
        checks: "none",
        deployConfigured: false,
      }) as PrStatus,
    defaultBranch: async () => "main",
    merge: async () => {},
    redeploy: async () => {},
    postReview: async () => ({}) as never,
    closeIssue: async (n: number) => {
      closeIssueCalls.push(n);
    },
    ensureIssueLink: async () => {},
    addIssueLabel: async () => {},
    removeIssueLabel: async () => {},
    getIssue: async (n: number): Promise<Issue | null> =>
      n === PARENT
        ? {
            number: PARENT,
            title: "feat review",
            body: "epic body",
            url: `https://x/${PARENT}`,
            labels: [],
            createdAt: 0,
            assignees: [],
          }
        : null,
    listSubIssues: async () => opts.subIssues,
    listBlockedBy: async () => [],
  };

  const drain = new DrainService({
    store,
    service: {
      create: async () => {
        throw new Error("spawn not expected in these tests");
      },
      archive: async (id: string) => {
        archiveCalls.push(id);
        return store.archive(id);
      },
    } as never,
    resolveForge: () => forge,
    prCache: { snapshot: () => prSnap },
    usage: { limits: (): UsageLimitsType => NO_USAGE },
    repos: () => [REPO],
    emitStatus: () => {},
    emitArchived: () => {},
    dropPrCache: () => {},
    emitEpic: () => {},
    emitEpicCompleted: () => {},
    now: () => clock.now,
    rebaseCap: 5,
  });

  return { store, drain, prByBranch, prStatusCalls, closeIssueCalls, archiveCalls, prSnap, clock };
}

function addSession(
  h: Harness,
  over: { branch: string; auto: boolean; issueNumber: number; archived?: boolean },
) {
  const s = h.store.create({
    name: over.branch,
    prompt: "p",
    repoPath: REPO,
    baseBranch: PINNED,
    branch: over.branch,
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t",
    auto: over.auto,
    issueNumber: over.issueNumber,
  });
  if (over.archived) h.store.archive(s.id);
  return s;
}

function mergedGit(over: Partial<GitState> = {}): GitState {
  return {
    kind: "github",
    state: "merged",
    number: 176,
    url: "https://x/pull/176",
    baseRefName: PINNED,
    checks: "none",
    deployConfigured: false,
    ...over,
  } as GitState;
}

// ── event-time recording (#1401): merged observations record BEFORE the auto gate ──

describe("event-time epic-integration recording", () => {
  test("manual (auto=0) session merged out-of-band → row recorded, session untouched", async () => {
    const h = makeHarness({ subIssues: [sub(133, true), sub(134, false, true)] });
    const s = addSession(h, { branch: "shepherd/134-manual", auto: false, issueNumber: 134 });

    await h.drain.onGit(s.id, mergedGit());

    expect(h.store.isEpicIntegratedChild(REPO, 134)).toBe(true);
    const details = h.store.listEpicIntegratedDetails(REPO, PARENT);
    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({
      childNumber: 134,
      prNumber: 176,
      prUrl: "https://x/pull/176",
      mergedBase: PINNED,
    });
    // The drain still leaves manual sessions alone (no reap/archive/close).
    expect(h.archiveCalls).toHaveLength(0);
    expect(h.closeIssueCalls).toHaveLength(0);
  });

  test("auto session reap: records first, then settles ARCHIVE-ONLY (no out-of-band close, #1037)", async () => {
    const h = makeHarness({ subIssues: [sub(133, true), sub(134, false, true)] });
    const s = addSession(h, { branch: "shepherd/134-auto", auto: true, issueNumber: 134 });

    await h.drain.onGit(s.id, mergedGit());

    expect(h.store.isEpicIntegratedChild(REPO, 134)).toBe(true);
    expect(h.archiveCalls).toEqual([s.id]); // settled
    expect(h.closeIssueCalls).toHaveLength(0); // close reserved for the landing PR merge
  });

  test("merged into a non-pinned base → no row; auto settle closes the issue as before", async () => {
    const h = makeHarness({ subIssues: [sub(133, true), sub(134, false, true)] });
    const s = addSession(h, { branch: "shepherd/134-auto", auto: true, issueNumber: 134 });

    await h.drain.onGit(s.id, mergedGit({ baseRefName: "main" }));

    expect(h.store.isEpicIntegratedChild(REPO, 134)).toBe(false);
    expect(h.closeIssueCalls).toEqual([134]); // normal non-epic-child settle
    expect(h.archiveCalls).toEqual([s.id]);
  });
});

// ── reconcile sweep (#1401): tick() backfills stalled children ──────────────────

describe("reconcileEpicIntegrations", () => {
  test("acceptance shape (#128): dead predecessor row first, merged manual respawn second → probes BOTH branches, backfills, epic completes + landing PR opens in the same tick", async () => {
    const h = makeHarness({ subIssues: [sub(133, true), sub(134, false, true)] });
    // Older dead auto session: spawned first, died without a PR. createdAt-ordered store.list()
    // returns it BEFORE the respawn — first-match would probe only this branch and miss the fix.
    addSession(h, {
      branch: "shepherd/134-attempt-1",
      auto: true,
      issueNumber: 134,
      archived: true,
    });
    // Newer manual respawn whose PR actually merged into the pinned branch (TASK-1249 shape).
    addSession(h, { branch: "shepherd/134-manual", auto: false, issueNumber: 134, archived: true });
    h.prByBranch.set("shepherd/134-manual", {
      state: "merged",
      number: 176,
      url: "https://x/pull/176",
      baseRefName: PINNED,
      checks: "none",
      deployConfigured: false,
    } as PrStatus);

    await h.drain.tick();

    // Both distinct branches probed, in row order.
    expect(h.prStatusCalls.slice(0, 2)).toEqual(["shepherd/134-attempt-1", "shepherd/134-manual"]);
    // Row backfilled with the merged PR's facts.
    const details = h.store.listEpicIntegratedDetails(REPO, PARENT);
    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({ childNumber: 134, prNumber: 176, mergedBase: PINNED });
    // The normal pipeline took over: epic completed → landing PR opened — all within one tick.
    expect(h.store.getEpicRun(REPO)?.status).toBe("idle");
    const completed = h.store.listEpicCompleted(REPO);
    expect(completed).toHaveLength(1);
    expect(completed[0]!.landingState).toBe("open");
    expect(completed[0]!.landingPrNumber).toBe(999);
  });

  test("throttle: no re-probe within EPIC_RECONCILE_TTL_MS; probes again after it", async () => {
    const h = makeHarness({ subIssues: [sub(134, false, true)] });
    // Child's only PR is still open on the host → probe finds nothing to record.
    addSession(h, { branch: "shepherd/134-x", auto: true, issueNumber: 134, archived: true });
    h.prByBranch.set("shepherd/134-x", {
      state: "open",
      number: 176,
      checks: "pending",
      deployConfigured: false,
    } as PrStatus);

    await h.drain.tick();
    const probes = () => h.prStatusCalls.filter((b) => b === "shepherd/134-x").length;
    expect(probes()).toBe(1);

    h.clock.now += 60_000; // within the 5-min TTL
    await h.drain.tick();
    expect(probes()).toBe(1);

    h.clock.now += 5 * 60_000; // past the TTL
    await h.drain.tick();
    expect(probes()).toBe(2);
  });

  test("live session with an open PR in the snapshot is skipped (event-time owns it)", async () => {
    const h = makeHarness({ subIssues: [sub(134, false, true)] });
    const live = addSession(h, { branch: "shepherd/134-live", auto: true, issueNumber: 134 });
    h.prSnap[live.id] = {
      kind: "github",
      state: "open",
      number: 176,
      checks: "pending",
      deployConfigured: false,
    } as GitState;

    await h.drain.tick();

    expect(h.prStatusCalls).not.toContain("shepherd/134-live");
    expect(h.store.isEpicIntegratedChild(REPO, 134)).toBe(false);
  });

  test("merged into the wrong base → no record", async () => {
    const h = makeHarness({ subIssues: [sub(134, false, true)] });
    addSession(h, { branch: "shepherd/134-x", auto: true, issueNumber: 134, archived: true });
    h.prByBranch.set("shepherd/134-x", {
      state: "merged",
      number: 176,
      baseRefName: "main",
      checks: "none",
      deployConfigured: false,
    } as PrStatus);

    await h.drain.tick();

    expect(h.prStatusCalls).toContain("shepherd/134-x");
    expect(h.store.isEpicIntegratedChild(REPO, 134)).toBe(false);
    expect(h.store.getEpicRun(REPO)?.status).toBe("running"); // still stalled, fail-closed
  });

  test("probe error on one branch → warns, continues, records from the next", async () => {
    const h = makeHarness({ subIssues: [sub(133, true), sub(134, false, true)] });
    addSession(h, { branch: "shepherd/134-broken", auto: true, issueNumber: 134, archived: true });
    addSession(h, { branch: "shepherd/134-good", auto: false, issueNumber: 134, archived: true });
    h.prByBranch.set("shepherd/134-broken", () => {
      throw new Error("api down");
    });
    h.prByBranch.set("shepherd/134-good", {
      state: "merged",
      number: 176,
      url: "https://x/pull/176",
      baseRefName: PINNED,
      checks: "none",
      deployConfigured: false,
    } as PrStatus);

    await h.drain.tick();

    expect(h.store.isEpicIntegratedChild(REPO, 134)).toBe(true);
  });

  test("paused epic: sweep still backfills, but no completion until resumed", async () => {
    const h = makeHarness({
      subIssues: [sub(133, true), sub(134, false, true)],
      epicStatus: "paused",
    });
    addSession(h, { branch: "shepherd/134-x", auto: false, issueNumber: 134, archived: true });
    h.prByBranch.set("shepherd/134-x", {
      state: "merged",
      number: 176,
      baseRefName: PINNED,
      checks: "none",
      deployConfigured: false,
    } as PrStatus);

    await h.drain.tick();

    expect(h.store.isEpicIntegratedChild(REPO, 134)).toBe(true);
    expect(h.store.getEpicRun(REPO)?.status).toBe("paused");
    expect(h.store.listEpicCompleted(REPO)).toHaveLength(0);
  });

  test("no active epic → zero probes", async () => {
    const h = makeHarness({ subIssues: [], epicStatus: null });
    addSession(h, { branch: "shepherd/134-x", auto: true, issueNumber: 134, archived: true });

    await h.drain.tick();

    expect(h.prStatusCalls).toHaveLength(0);
  });
});
