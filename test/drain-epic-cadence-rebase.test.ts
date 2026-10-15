/**
 * Tests for the #1841 cadence rebase — `cadenceRebaseEpicBranchForRepo` in drain.ts.
 *
 * While an epic runs, its integration branch is rebased onto the default branch ONLY in a
 * quiescent window (no child running/in review, no session based on the branch). Throttled per
 * epic (1h). #3101: a branch behind the default branch for ≥4h holds new spawns until quiescent;
 * a conflict holds and dispatches one base-rework agent, then notifies.
 * The rebase + behind-probe seams are faked; `getIssue`/`listSubIssues` feed buildEpic.
 */
import { test, expect, describe } from "bun:test";
import { DrainService } from "../src/drain";
import { SessionStore } from "../src/store";
import type { GitForge, Issue, PrStatus, SubIssueRef } from "../src/forge/types";
import { EMPTY_BACKLOG_COUNTS } from "../src/forge/types";
import type { UsageLimits as UsageLimitsType } from "../src/usage-limits";
import type { BranchBehindResult, LandingRebaseResult } from "../src/landing-rebase";
import { computeNext } from "../src/drain-core";
import type { Session } from "../src/types";
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
  probes: number;
  /** What the behind-probe reports next; mutate to move "main". */
  probe: { kind: BranchBehindResult["kind"]; sha: string };
  /** What the rebase seam returns next. */
  rebase: { kind: LandingRebaseResult["kind"] };
  spawned: { prompt: string; baseBranch: string }[];
}

function makeHarness(
  opts: {
    epicStatus?: "running" | "idle" | "paused";
    draftMode?: boolean;
    forgeKind?: GitForge["kind"];
    integratedChild?: boolean;
    pin?: boolean;
    result?: LandingRebaseResult["kind"];
    autoDrain?: boolean;
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
    autoDrainEnabled: opts.autoDrain ?? false,
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
  const probe: Harness["probe"] = { kind: "behind", sha: "m1" };
  const rebase: Harness["rebase"] = { kind: opts.result ?? "rebased" };
  const spawned: Harness["spawned"] = [];
  const counters = { probes: 0 };
  const drain = new DrainService({
    store,
    service: {
      create: async (input: {
        prompt: string;
        baseBranch: string;
        landingRepair?: boolean;
      }): Promise<Session> => {
        spawned.push({ prompt: input.prompt, baseBranch: input.baseBranch });
        return store.create({
          name: "rework",
          prompt: input.prompt,
          repoPath: REPO,
          baseBranch: input.baseBranch,
          branch: "rework/x",
          worktreePath: "/wt-rework",
          isolated: true,
          herdrSession: "default",
          herdrAgentId: "r",
          auto: true,
          issueNumber: null,
          landingRepair: !!input.landingRepair,
        });
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
      const kind = rebase.kind;
      return (kind === "rebased" ? { kind, headSha: "abc" } : { kind }) as LandingRebaseResult;
    },
    branchBehindDefault: async () => {
      counters.probes += 1;
      return (
        probe.kind === "transient"
          ? { kind: "transient" }
          : { kind: probe.kind, defaultSha: probe.sha }
      ) as BranchBehindResult;
    },
  });
  return {
    store,
    drain,
    calls,
    clock,
    notifies,
    get probes() {
      return counters.probes;
    },
    probe,
    rebase,
    spawned,
  };
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

  test("#3101: a pinned branch with no integrated child is still rebased (left over from an earlier run)", async () => {
    const h = makeHarness({ integratedChild: false });
    await callPass(h);
    expect(h.calls).toHaveLength(1);
  });

  test("#3101: branch already current → no rebase", async () => {
    const h = makeHarness();
    h.probe.kind = "current";
    await callPass(h);
    expect(h.calls).toHaveLength(0);
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

// ── #3101: base freshness holds ─────────────────────────────────────────────────────────────────

async function holdCode(h: Harness): Promise<string | null> {
  const { state } = await (
    h.drain as unknown as {
      buildState: (r: string) => Promise<{ state: Parameters<typeof computeNext>[0] }>;
    }
  ).buildState(REPO);
  const d = computeNext(state);
  return d.kind === "hold" ? d.reason.code : null;
}

function restart(h: Harness): Harness {
  // A fresh DrainService on the SAME store: in-memory throttles/overrides are gone.
  const next = makeHarness();
  const d = new DrainService({
    ...(next.drain as unknown as { deps: ConstructorParameters<typeof DrainService>[0] }).deps,
    store: h.store,
  });
  return { ...h, drain: d, calls: next.calls };
}

describe("epic base freshness (#3101)", () => {
  test("main moves during an epic run: busy epic holds after 4h, rebases once quiescent, resumes", async () => {
    const h = makeHarness();
    addSession(h, { issueNumber: CHILD2, baseBranch: BRANCH }); // a child in flight
    await callPass(h);
    expect(h.calls).toHaveLength(0); // not quiescent → no rebase
    expect(h.store.getEpicBaseFreshness(REPO, PARENT)?.behindSince).toBe(h.clock.t);
    expect(await holdCode(h)).not.toBe("epic_base_stale");

    h.clock.t += 4 * HOUR - 1;
    expect(await holdCode(h)).not.toBe("epic_base_stale");
    h.clock.t += 1;
    expect(await holdCode(h)).toBe("epic_base_stale");

    // Armed + still busy: every tick re-checks quiescence, without another fetch.
    const probes = h.probes;
    await callPass(h);
    expect(h.probes).toBe(probes);
    expect(h.calls).toHaveLength(0);

    // The child finishes → next tick rebases (no hourly throttle) and the hold clears.
    h.store.archive(h.store.list().find((s) => s.issueNumber === CHILD2)!.id);
    await callPass(h);
    expect(h.calls).toHaveLength(1);
    expect(h.store.getEpicBaseFreshness(REPO, PARENT)?.behindSince).toBeNull();
    expect(await holdCode(h)).not.toBe("epic_base_stale");
  });

  test("the stale clock survives a restart", async () => {
    const h = makeHarness();
    addSession(h, { issueNumber: CHILD2, baseBranch: BRANCH });
    await callPass(h);
    const since = h.store.getEpicBaseFreshness(REPO, PARENT)?.behindSince;
    const r = restart(h);
    r.clock.t += 4 * HOUR;
    await callPass(r);
    expect(r.store.getEpicBaseFreshness(REPO, PARENT)?.behindSince).toBe(since!);
  });

  test("conflict → hold + one auto rework agent; a second conflict notifies instead", async () => {
    const h = makeHarness({ result: "conflict", autoDrain: true });
    await callPass(h);
    expect(await holdCode(h)).toBe("epic_base_conflict");
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]!.baseBranch).toBe(BRANCH);
    expect(h.spawned[0]!.prompt).toContain(`git push --force-with-lease=${BRANCH}:<lease-sha>`);
    expect(h.notifies).toHaveLength(0);

    // The rework session holds the branch → the pass is fenced.
    await callPass(h);
    expect(h.calls).toHaveLength(1);

    // It ends without fixing it → retried at once; cap spent → notify, no second agent.
    h.store.archive(h.store.list().find((s) => s.landingRepair)!.id);
    await callPass(h);
    expect(h.calls).toHaveLength(2);
    expect(h.spawned).toHaveLength(1);
    expect(h.notifies).toEqual([
      expect.objectContaining({ kind: "epic_base_conflict", epicNumber: PARENT }),
    ]);
    expect(await holdCode(h)).toBe("epic_base_conflict");
  });

  test("conflict resolved → hold clears and the rework budget resets", async () => {
    const h = makeHarness({ result: "conflict", autoDrain: true });
    await callPass(h);
    h.store.archive(h.store.list().find((s) => s.landingRepair)!.id);
    h.probe.kind = "current"; // the agent's push brought the branch up to date
    await callPass(h);
    expect(await holdCode(h)).not.toBe("epic_base_conflict");
    expect(h.store.getEpicBaseFreshness(REPO, PARENT)).toEqual({
      behindSince: null,
      conflictSince: null,
      reworkCount: 0,
    });
  });

  test("auto-drain off → no agent, notify; the manual dispatch bypasses it", async () => {
    const h = makeHarness({ result: "conflict" });
    await callPass(h);
    expect(h.spawned).toHaveLength(0);
    expect(h.notifies).toHaveLength(1);
    expect(await h.drain.resolveEpicBaseConflict(REPO, PARENT)).toEqual({ ok: true });
    expect(h.spawned).toHaveLength(1);
    // A live repair session refuses a second one.
    expect(await h.drain.resolveEpicBaseConflict(REPO, PARENT)).toEqual({
      ok: false,
      error: "busy",
    });
  });

  test("manual resolve without a conflict → not-conflicting", async () => {
    const h = makeHarness();
    expect(await h.drain.resolveEpicBaseConflict(REPO, PARENT)).toEqual({
      ok: false,
      error: "not-conflicting",
    });
  });

  test("override lifts base holds until the default branch moves", async () => {
    const h = makeHarness({ result: "conflict" });
    await callPass(h);
    expect(await holdCode(h)).toBe("epic_base_conflict");
    expect(await h.drain.overrideEpicBaseHold(REPO, PARENT, "base")).toEqual({ ok: true });
    expect(await holdCode(h)).not.toBe("epic_base_conflict");
    // The override kicks a pump; let it finish before the next pass (it holds the pump slot).
    while ((h.drain as unknown as { pumping: Set<string> }).pumping.has(REPO))
      await new Promise((r) => setTimeout(r, 1));
    h.probe.sha = "m2"; // main moved
    h.clock.t += HOUR;
    await callPass(h);
    expect(await holdCode(h)).toBe("epic_base_conflict");
  });

  test("an unstarted epic holds while another epic's landing is open; override lifts it", async () => {
    const h = makeHarness({ integratedChild: false });
    h.store.recordEpicCompleted({
      repoPath: REPO,
      parentIssueNumber: 55,
      parentTitle: "M1",
      completedAt: 1,
      childrenJson: "[]",
    });
    expect(await holdCode(h)).toBe("epic_predecessor_unlanded");
    expect(await h.drain.overrideEpicBaseHold(REPO, PARENT, "predecessor")).toEqual({ ok: true });
    expect(await holdCode(h)).not.toBe("epic_predecessor_unlanded");
  });

  test("an epic already under way is not held for a predecessor", async () => {
    const h = makeHarness(); // CHILD integrated
    h.store.recordEpicCompleted({
      repoPath: REPO,
      parentIssueNumber: 55,
      parentTitle: "M1",
      completedAt: 1,
      childrenJson: "[]",
    });
    expect(await holdCode(h)).not.toBe("epic_predecessor_unlanded");
  });
});
