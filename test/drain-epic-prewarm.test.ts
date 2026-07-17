/**
 * Tests for the #1664 pre-warm pass — `ensureDraftLandingPrForRepo` in drain.ts.
 *
 * The pass opens the epic's aggregate landing PR EARLY as a draft while the epic is still
 * draining, to warm its CI. It is opt-in (`preWarmEpicLandingCi`), engaged-only (running,
 * non-draft-mode), GitHub-only, and — load-bearing — writes NO `epic_completed` DB row.
 *
 * The forge `prStatus`/`openPr` are faked per-test; `getIssue`/`listSubIssues` feed buildEpic.
 */
import { test, expect, describe } from "bun:test";
import { DrainService } from "../src/drain";
import { SessionStore } from "../src/store";
import type { GitForge, Issue, OpenPrInput, PrStatus, SubIssueRef } from "../src/forge/types";
import { EMPTY_BACKLOG_COUNTS, EmptyDiffError } from "../src/forge/types";
import type { UsageLimits as UsageLimitsType } from "../src/usage-limits";
import { epicIntegrationBranch } from "../src/epic-branch";

const REPO = "/repo";
const PARENT = 327;
const PARENT_TITLE = "EFI cluster";
const CHILD = 320;
const INTEGRATION_BRANCH = epicIntegrationBranch(PARENT, PARENT_TITLE); // epic/327-efi-cluster

const NO_USAGE: UsageLimitsType = {
  session5h: null,
  week: null,
  perModelWeek: [],
  credits: null,
  stale: false,
  calibratedAt: null,
  subscriptionOnly: false,
};

interface ForgeSpy {
  forge: GitForge;
  openPrCalls: OpenPrInput[];
  prStatusCalls: string[];
}

function fakeForge(opts: {
  kind?: "github" | "gitea" | "local";
  prStatus?: (branch: string) => Promise<PrStatus>;
  openPr?: (o: OpenPrInput) => Promise<PrStatus>;
}): ForgeSpy {
  const openPrCalls: OpenPrInput[] = [];
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
    openPr: async (o: OpenPrInput) => {
      openPrCalls.push(o);
      return (
        (await opts.openPr?.(o)) ??
        ({ state: "open", checks: "none", deployConfigured: false } as PrStatus)
      );
    },
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
        ? [{ number: CHILD, title: "child 320", url: "u320", body: "", closed: false, labels: [] }]
        : [],
    listBlockedBy: async () => [],
  };
  return { forge, openPrCalls, prStatusCalls };
}

interface Harness {
  store: SessionStore;
  drain: DrainService;
  spy: ForgeSpy;
}

function makeHarness(
  opts: {
    preWarm?: boolean;
    epicStatus?: "running" | "idle" | "paused";
    draftMode?: boolean;
    github?: boolean;
    integratedChild?: boolean;
    pin?: boolean;
    prStatus?: (branch: string) => Promise<PrStatus>;
    openPr?: (o: OpenPrInput) => Promise<PrStatus>;
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
    preWarmEpicLandingCi: opts.preWarm ?? false,
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
  if (opts.pin !== false) {
    store.getOrInitEpicIntegrationBranch(REPO, PARENT, INTEGRATION_BRANCH);
  }

  const spy = fakeForge({
    kind: opts.github === false ? "gitea" : "github",
    prStatus: opts.prStatus,
    openPr: opts.openPr,
  });

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
    emitEpicCompleted: () => {},
    rebaseCap: 5,
  });

  return { store, drain, spy };
}

/** Invoke the private pre-warm pass directly (isolates prStatus/openPr to it). */
function callPass(h: Harness): Promise<void> {
  return (
    h.drain as unknown as { ensureDraftLandingPrForRepo: (repoPath: string) => Promise<void> }
  ).ensureDraftLandingPrForRepo(REPO);
}

describe("ensureDraftLandingPrForRepo (#1664)", () => {
  test("flag off → openPr NOT called", async () => {
    const h = makeHarness({ preWarm: false });
    await callPass(h);
    expect(h.spy.openPrCalls).toHaveLength(0);
    expect(h.spy.prStatusCalls).toHaveLength(0);
  });

  test("flag on + running + github + integrated child + no existing PR → opens ONE draft with marker, writes NO row", async () => {
    const h = makeHarness({ preWarm: true, prStatus: async () => ({ state: "none" }) as PrStatus });
    await callPass(h);

    expect(h.spy.openPrCalls).toHaveLength(1);
    const call = h.spy.openPrCalls[0]!;
    expect(call.draft).toBe(true);
    expect(call.head).toBe(INTEGRATION_BRANCH);
    expect(call.base).toBe("main");
    expect(call.body).toContain("Pre-warm draft");
    // Load-bearing: NO epic_completed row written by this pass.
    expect(h.store.listEpicCompleted(REPO)).toHaveLength(0);
  });

  test("existing OPEN PR → openPr NOT called (no second PR)", async () => {
    const h = makeHarness({ preWarm: true, prStatus: async () => ({ state: "open" }) as PrStatus });
    await callPass(h);
    expect(h.spy.openPrCalls).toHaveLength(0);
  });

  test("existing CLOSED PR → openPr NOT called (not re-opened mid-run)", async () => {
    const h = makeHarness({
      preWarm: true,
      prStatus: async () => ({ state: "closed" }) as PrStatus,
    });
    await callPass(h);
    expect(h.spy.openPrCalls).toHaveLength(0);
  });

  test("non-GitHub forge → openPr NOT called", async () => {
    const h = makeHarness({ preWarm: true, github: false });
    await callPass(h);
    expect(h.spy.openPrCalls).toHaveLength(0);
    expect(h.spy.prStatusCalls).toHaveLength(0);
  });

  test("no integrated children → openPr NOT called", async () => {
    const h = makeHarness({ preWarm: true, integratedChild: false });
    await callPass(h);
    expect(h.spy.openPrCalls).toHaveLength(0);
    expect(h.spy.prStatusCalls).toHaveLength(0);
  });

  test("epic not running (idle) → openPr NOT called", async () => {
    const h = makeHarness({ preWarm: true, epicStatus: "idle" });
    await callPass(h);
    expect(h.spy.openPrCalls).toHaveLength(0);
    expect(h.spy.prStatusCalls).toHaveLength(0);
  });

  test("draftMode ON → openPr NOT called", async () => {
    const h = makeHarness({ preWarm: true, draftMode: true });
    await callPass(h);
    expect(h.spy.openPrCalls).toHaveLength(0);
    expect(h.spy.prStatusCalls).toHaveLength(0);
  });

  test("unpinned integration branch → openPr NOT called", async () => {
    const h = makeHarness({ preWarm: true, pin: false });
    await callPass(h);
    expect(h.spy.openPrCalls).toHaveLength(0);
    expect(h.spy.prStatusCalls).toHaveLength(0);
  });

  test("buildEpic returns null → openPr NOT called, no throw", async () => {
    const h = makeHarness({ preWarm: true, prStatus: async () => ({ state: "none" }) as PrStatus });
    (h.drain as unknown as { buildEpic: () => Promise<null> }).buildEpic = async () => null;
    await callPass(h);
    expect(h.spy.openPrCalls).toHaveLength(0);
  });

  test("EmptyDiffError from openPr → swallowed silently, no throw, no row", async () => {
    const h = makeHarness({
      preWarm: true,
      prStatus: async () => ({ state: "none" }) as PrStatus,
      openPr: async () => {
        throw new EmptyDiffError(INTEGRATION_BRANCH, "main");
      },
    });
    await expect(callPass(h)).resolves.toBeUndefined();
    expect(h.store.listEpicCompleted(REPO)).toHaveLength(0);
  });

  test("whole-body guard: prStatus throwing does not reject the pass", async () => {
    const h = makeHarness({
      preWarm: true,
      prStatus: async () => {
        throw new Error("prStatus boom");
      },
    });
    await expect(callPass(h)).resolves.toBeUndefined();
    expect(h.spy.openPrCalls).toHaveLength(0);
  });
});
