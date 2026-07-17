import { test, expect, describe } from "bun:test";
import { DrainService } from "../src/drain";
import { SessionStore } from "../src/store";
import type { GitForge, Issue, PrStatus, SubIssueRef } from "../src/forge/types";
import { EMPTY_BACKLOG_COUNTS } from "../src/forge/types";
import type { UsageLimits as UsageLimitsType } from "../src/usage-limits";
import type { CompletedEpic, CompletedEpicChild } from "../src/completed-epic";

const REPO = "/repo";
const PARENT = 327;

const NO_USAGE: UsageLimitsType = {
  session5h: null,
  week: null,
  perModelWeek: [],
  credits: null,
  stale: false,
  calibratedAt: null,
  subscriptionOnly: false,
};

/** A forge whose epic has the given native sub-issues (closed flag drives "merged"). */
function fakeForge(
  subIssues: SubIssueRef[],
  listBlockedByImpl?: (n: number) => Promise<number[]>,
): GitForge {
  return {
    kind: "github",
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
            title: "EFI cluster",
            body: "epic body",
            url: `https://x/${PARENT}`,
            labels: [],
            createdAt: 0,
            assignees: [],
          }
        : null,
    listSubIssues: async () => subIssues,
    listBlockedBy: listBlockedByImpl ?? (async () => []),
  };
}

function sub(number: number, closed: boolean): SubIssueRef {
  return {
    number,
    title: `child ${number}`,
    url: `https://x/${number}`,
    body: "",
    closed,
    labels: [],
  };
}

interface HarnessOpts {
  subIssues: SubIssueRef[];
  /** Override recordEpicCompleted on the store (e.g. to throw). */
  recordImpl?: () => void;
  /** Override listBlockedBy on the forge (defaults to always returning []). */
  listBlockedByImpl?: (n: number) => Promise<number[]>;
}

interface Harness {
  store: SessionStore;
  drain: DrainService;
  completedEmits: CompletedEpic[];
  telemetryEvents: { name: string; props: any }[];
}

function makeHarness(opts: HarnessOpts): Harness {
  const store = new SessionStore(":memory:");
  store.setRepoConfig(REPO, {
    criticEnabled: true,
    criticAllPrs: false,
    criticSmellLensEnabled: false,
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
  store.setEpicRun({
    repoPath: REPO,
    parentIssueNumber: PARENT,
    mode: "auto",
    status: "running",
  });

  if (opts.recordImpl) {
    store.recordEpicCompleted = opts.recordImpl as typeof store.recordEpicCompleted;
  }

  const forge = fakeForge(opts.subIssues, opts.listBlockedByImpl);
  const completedEmits: CompletedEpic[] = [];
  const telemetryEvents: { name: string; props: any }[] = [];

  const service = {
    create: async () => {
      throw new Error("not used in these tests");
    },
    archive: () => 1,
  };

  const drain = new DrainService({
    store,
    service: service as never,
    resolveForge: () => forge,
    prCache: { snapshot: () => ({}) },
    usage: { limits: (): UsageLimitsType => NO_USAGE },
    repos: () => [REPO],
    emitStatus: () => {},
    emitArchived: () => {},
    dropPrCache: () => {},
    emitEpic: () => {},
    emitEpicCompleted: (e) => completedEmits.push(e),
    telemetry: { event: (name, props) => telemetryEvents.push({ name, props }) },
    rebaseCap: 5,
  });

  return { store, drain, completedEmits, telemetryEvents };
}

describe("epic auto-complete → record before idle flip (#635)", () => {
  test("all children merged: records epic_completed + emits BEFORE flipping run to idle", async () => {
    const h = makeHarness({ subIssues: [sub(320, true), sub(321, true)] });

    await h.drain.pump(REPO);

    const rows = h.store.listEpicCompleted(REPO);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.parentIssueNumber).toBe(PARENT);
    expect(row.parentTitle).toBe("EFI cluster");

    // Run flipped to idle.
    expect(h.store.getEpicRun(REPO)?.status).toBe("idle");

    // Two emits: the completion record, then the Stage B (#635) landing-PR resolution. Both
    // children are issue-closed (no epic_integrated rows) so the landing resolves to 'none'.
    expect(h.completedEmits.length).toBeGreaterThanOrEqual(1);
    const emit = h.completedEmits[0]!;
    expect(emit.parentIssueNumber).toBe(PARENT);
    expect(emit.children.map((c) => c.number).sort()).toEqual([320, 321]);
    // Last emit carries the resolved landing state (no integrated children → 'none').
    expect(h.completedEmits.at(-1)!.landingState).toBe("none");
  });

  test("record failure keeps the epic RUNNING (no flip, no row) → retried next pump", async () => {
    // console.warn "[drain] epic-completed record failed…" is expected here
    const h = makeHarness({
      subIssues: [sub(320, true), sub(321, true)],
      recordImpl: () => {
        throw new Error("disk full");
      },
    });

    await h.drain.pump(REPO);

    expect(h.store.getEpicRun(REPO)?.status).toBe("running"); // NOT idle
    expect(h.store.listEpicCompleted(REPO)).toHaveLength(0);
    expect(h.completedEmits).toHaveLength(0);
    expect(h.telemetryEvents.filter((e) => e.name === "epic_drained")).toHaveLength(0);
  });

  test("fires epic_drained exactly once on completion with childCount", async () => {
    const h = makeHarness({ subIssues: [sub(320, true), sub(321, true)] });

    await h.drain.pump(REPO);

    const drained = h.telemetryEvents.filter((e) => e.name === "epic_drained");
    expect(drained).toHaveLength(1);
    expect(drained[0]!.props).toEqual({ childCount: 2 });
    expect(typeof drained[0]!.props.childCount).toBe("number");
  });

  test("not all merged: no record, run stays running", async () => {
    // #322 is an open in-epic dep, making #321 blocked (not spawnable) so no service.create noise.
    const h = makeHarness({
      subIssues: [sub(320, true), sub(321, false), sub(322, false)],
      // 321→322 and 322→321 form a circular dep; assembleEpic accepts it (no cycle check),
      // both derive as blocked, so neither is spawnable and service.create is never called.
      listBlockedByImpl: async (n: number) => (n === 321 ? [322] : n === 322 ? [321] : []),
    });

    await h.drain.pump(REPO);

    expect(h.store.listEpicCompleted(REPO)).toHaveLength(0);
    expect(h.store.getEpicRun(REPO)?.status).toBe("running");
    expect(h.completedEmits).toHaveLength(0);
  });

  test("mixed: integrated child carries PR facts, issue-closed child has integrated:false/null PR", async () => {
    // 320 integration-merged with PR facts; 321 issue-closed (no detail row). Both → state merged.
    const h = makeHarness({ subIssues: [sub(320, false), sub(321, true)] });
    h.store.recordEpicIntegrated(REPO, PARENT, 320, {
      number: 9001,
      url: "https://github.com/o/r/pull/9001",
    });

    await h.drain.pump(REPO);

    const rows = h.store.listEpicCompleted(REPO);
    expect(rows).toHaveLength(1);
    const children = JSON.parse(rows[0]!.childrenJson) as CompletedEpicChild[];
    const byNum = new Map(children.map((c) => [c.number, c]));

    const integrated = byNum.get(320)!;
    expect(integrated.integrated).toBe(true);
    expect(integrated.prNumber).toBe(9001);
    expect(integrated.prUrl).toBe("https://github.com/o/r/pull/9001");
    expect(integrated.mergedAt).toBeGreaterThan(0);

    const closed = byNum.get(321)!;
    expect(closed.integrated).toBe(false);
    expect(closed.prNumber).toBeNull();
    expect(closed.prUrl).toBeNull();
    expect(closed.mergedAt).toBeNull();

    expect(h.store.getEpicRun(REPO)?.status).toBe("idle");
  });
});
