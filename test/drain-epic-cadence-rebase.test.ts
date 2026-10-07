/**
 * Tests for the #1841 cadence rebase — `cadenceRebaseEpicBranchForRepo` in drain.ts.
 *
 * While an epic runs, its integration branch is rebased onto the default branch ONLY in a
 * quiescent window (no child running/in review, no session based on the branch). Throttled per
 * epic (1h; 6h after a conflict); a conflict writes nothing and notifies nobody.
 * The rebase seam is faked; `getIssue`/`listSubIssues` feed buildEpic.
 */
import { test, expect, describe } from "bun:test";
import { DrainService } from "../src/drain";
import { SessionStore } from "../src/store";
import type { GitForge, Issue, PrStatus, SubIssueRef } from "../src/forge/types";
import { EMPTY_BACKLOG_COUNTS } from "../src/forge/types";
import type { UsageLimits as UsageLimitsType } from "../src/usage-limits";
import type { LandingRebaseResult } from "../src/landing-rebase";
import { epicIntegrationBranch } from "../src/epic-branch";

const REPO = "/repo";
const PARENT = 327;
const PARENT_TITLE = "EFI cluster";
const CHILD = 320; // integrated
const CHILD2 = 321; // open
const BRANCH = epicIntegrationBranch(PARENT, PARENT_TITLE);
const HOUR = 60 * 60_000;

const NO_USAGE: UsageLimitsType = {
  session5h: null,
  week: null,
  perModelWeek: [],
  credits: null,
  stale: false,
  calibratedAt: null,
  subscriptionOnly: false,
};

function fakeForge(kind: GitForge["kind"]): GitForge {
  return {
    kind,
    slug: "o/r",
    mergeMethod: "squash",
    deployWorkflow: null,
    listIssues: async () => [],
    listPullRequests: async () => [],
    listBacklogCounts: async () => EMPTY_BACKLOG_COUNTS,
    prStatus: async () => ({ state: "none", checks: "none", deployConfigured: false }) as PrStatus,
    openPr: async () => ({ state: "open", checks: "none", deployConfigured: false }) as PrStatus,
    defaultBranch: async () => "main",
    merge: async () => {},
    redeploy: async () => {},
    postReview: async () => ({}),
    closeIssue: async () => {},
    ensureIssueLink: async () => {},
    addIssueLabel: async () => {},
    removeIssueLabel: async () => {},
    getIssue: async (n: number): Promise<Issue | null> =>
      n === PARENT
        ? {
            number: PARENT,
            title: PARENT_TITLE,
            body: "epic body",
            url: `https://x/${PARENT}`,
            labels: [],
            createdAt: 0,
            assignees: [],
          }
        : null,
    listSubIssues: async (n: number): Promise<SubIssueRef[]> =>
      n === PARENT
        ? [
            { number: CHILD, title: "c320", url: "u320", body: "", closed: false, labels: [] },
            { number: CHILD2, title: "c321", url: "u321", body: "", closed: false, labels: [] },
          ]
        : [],
    listBlockedBy: async () => [],
  };
}

interface Harness {
  store: SessionStore;
  drain: DrainService;
  calls: Array<{ branch: string; defaultBranch: string }>;
  clock: { t: number };
  notifies: unknown[];
}

function makeHarness(
  opts: {
    epicStatus?: "running" | "idle" | "paused";
    draftMode?: boolean;
    forgeKind?: GitForge["kind"];
    integratedChild?: boolean;
    pin?: boolean;
    result?: LandingRebaseResult["kind"];
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
    autoDrainEnabled: false,
    autoMergeEnabled: false,
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
    epicStacksEnabled: false,
    sharedBrowserEnabled: false,
    browserAllowedHosts: [],
    hidden: false,
  });
  store.setEpicRun({
    repoPath: REPO,
    parentIssueNumber: PARENT,
    mode: "auto",
    status: opts.epicStatus ?? "running",
  });
  if (opts.integratedChild !== false) {
    store.recordEpicIntegrated(REPO, PARENT, CHILD, {
      number: 9320,
      url: "https://github.com/o/r/pull/9320",
    });
  }
  if (opts.pin !== false) store.getOrInitEpicIntegrationBranch(REPO, PARENT, BRANCH);

  const forge = fakeForge(opts.forgeKind ?? "github");
  const calls: Harness["calls"] = [];
  const clock = { t: 1_000_000 };
  const notifies: unknown[] = [];
  const drain = new DrainService({
    store,
    service: {
      create: async () => {
        throw new Error("not used");
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
    notify: async (n) => {
      notifies.push(n);
      return true;
    },
    now: () => clock.t,
    rebaseCap: 5,
    rebaseLandingBranch: async (_repo: string, branch: string, defaultBranch: string) => {
      calls.push({ branch, defaultBranch });
      const kind = opts.result ?? "rebased";
      return (kind === "rebased" ? { kind, headSha: "abc" } : { kind }) as LandingRebaseResult;
    },
  });
  return { store, drain, calls, clock, notifies };
}

function addSession(
  h: Harness,
  o: { issueNumber?: number; baseBranch?: string; landingRepair?: boolean } = {},
): void {
  h.store.create({
    name: "s",
    prompt: "p",
    repoPath: REPO,
    baseBranch: o.baseBranch ?? "main",
    branch: "feat/x",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t",
    auto: true,
    issueNumber: o.issueNumber ?? null,
    landingRepair: o.landingRepair ?? false,
  });
}

function callPass(h: Harness): Promise<void> {
  return (
    h.drain as unknown as { cadenceRebaseEpicBranchForRepo: (r: string) => Promise<void> }
  ).cadenceRebaseEpicBranchForRepo(REPO);
}

describe("cadenceRebaseEpicBranchForRepo (#1841)", () => {
  test("running + quiescent + integrated child → rebases the integration branch onto default", async () => {
    const h = makeHarness();
    await callPass(h);
    expect(h.calls).toEqual([{ branch: BRANCH, defaultBranch: "main" }]);
  });

  test("a running child (auto session on an open child issue) blocks", async () => {
    const h = makeHarness();
    addSession(h, { issueNumber: CHILD2, baseBranch: "elsewhere" });
    await callPass(h);
    expect(h.calls).toHaveLength(0);
  });

  test("any session based on the integration branch blocks", async () => {
    const h = makeHarness();
    addSession(h, { baseBranch: BRANCH });
    await callPass(h);
    expect(h.calls).toHaveLength(0);
  });

  test("a live repair session on the branch blocks", async () => {
    const h = makeHarness();
    addSession(h, { baseBranch: BRANCH, landingRepair: true });
    await callPass(h);
    expect(h.calls).toHaveLength(0);
  });

  test.each([
    ["epic idle", { epicStatus: "idle" as const }],
    ["epic paused", { epicStatus: "paused" as const }],
    ["draft mode", { draftMode: true }],
    ["non-GitHub forge", { forgeKind: "gitea" as const }],
    ["no integrated child", { integratedChild: false }],
    ["unpinned branch", { pin: false }],
  ])("%s → no rebase", async (_label, opts) => {
    const h = makeHarness(opts);
    await callPass(h);
    expect(h.calls).toHaveLength(0);
  });

  test("throttled to one attempt per hour", async () => {
    const h = makeHarness();
    await callPass(h);
    h.clock.t += HOUR - 1;
    await callPass(h);
    expect(h.calls).toHaveLength(1);
    h.clock.t += 1;
    await callPass(h);
    expect(h.calls).toHaveLength(2);
  });

  test("conflict → 6h back-off, no store row, no notify", async () => {
    const h = makeHarness({ result: "conflict" });
    await callPass(h);
    expect(h.calls).toHaveLength(1);
    h.clock.t += 6 * HOUR - 1;
    await callPass(h);
    expect(h.calls).toHaveLength(1);
    h.clock.t += 1;
    await callPass(h);
    expect(h.calls).toHaveLength(2);
    expect(h.store.listEpicCompleted(REPO)).toHaveLength(0);
    expect(h.notifies).toHaveLength(0);
  });

  test("a pump already running for the repo → skip (no rebase)", async () => {
    const h = makeHarness();
    (h.drain as unknown as { pumping: Set<string> }).pumping.add(REPO);
    await callPass(h);
    expect(h.calls).toHaveLength(0);
  });

  test("holds the pump slot across the rebase: an event-driven pump mid-rewrite spawns nothing", async () => {
    const h = makeHarness();
    const d = h.drain as unknown as {
      pumping: Set<string>;
      pumpStep: () => Promise<boolean>;
      rebaseLandingBranch: (...a: unknown[]) => Promise<LandingRebaseResult>;
    };
    let steps = 0;
    d.pumpStep = async () => {
      steps += 1;
      return false;
    };
    let heldDuringRebase = false;
    d.rebaseLandingBranch = async () => {
      heldDuringRebase = d.pumping.has(REPO);
      await h.drain.pump(REPO); // e.g. a status/review event lands mid-rebase
      return { kind: "rebased", headSha: "abc" };
    };
    await callPass(h);
    expect(heldDuringRebase).toBe(true);
    expect(steps).toBe(0);
    expect(d.pumping.has(REPO)).toBe(false); // released afterwards
    await h.drain.pump(REPO);
    expect(steps).toBe(1);
  });

  test("tick() runs the cadence rebase before the pump", async () => {
    const h = makeHarness();
    const order: string[] = [];
    const d = h.drain as unknown as {
      cadenceRebaseEpicBranchForRepo: (r: string) => Promise<void>;
      pump: (r: string) => Promise<void>;
    };
    const orig = d.cadenceRebaseEpicBranchForRepo.bind(h.drain);
    d.cadenceRebaseEpicBranchForRepo = async (r) => {
      order.push("cadence");
      await orig(r);
    };
    d.pump = async () => {
      order.push("pump");
    };
    await h.drain.tick();
    expect(order).toEqual(["cadence", "pump"]);
    expect(h.calls).toHaveLength(1);
  });
});
