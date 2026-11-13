/**
 * #2858: the drain pushes `epic:landing-gate` when an open landing row's gate moves, observed from
 * reads the tick already made (the passes' shared read, else a current open-PR snapshot).
 * Acceptance: no extra forge calls where a pass or snapshot covers the landing (only an uncovered
 * one falls back to the shared TTL read); no push while the signature holds; a green landing PR
 * reaches clients within one tick.
 */
import { test, expect, describe } from "bun:test";
import { DrainService } from "../src/drain";
import { SessionStore } from "../src/store";
import type { GitForge, Issue, OpenPrSnapshot, PrStatus, SubIssueRef } from "../src/forge/types";
import { EMPTY_BACKLOG_COUNTS } from "../src/forge/types";
import type { UsageLimits as UsageLimitsType } from "../src/usage-limits";
import type { CompletedEpic } from "../src/completed-epic";
import { epicIntegrationBranch } from "../src/epic-branch";

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
  /** Rows pushed through `emitLandingGate` (#2858). */
  gates: CompletedEpic[];
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
    /** Wire `emitLandingGate` (default true). */
    emit?: boolean;
    /** Wire `landingPrFallback`: "read" reads the forge, "skip" answers null (no client). */
    fallback?: "read" | "skip";
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
  const gates: CompletedEpic[] = [];

  const store = new SessionStore(":memory:");
  store.setRepoConfig(REPO, {
    criticEnabled: false,
    criticAllPrs: false,
    criticSmellLensEnabled: false,
    autoAddressEnabled: false,
    autopilotEnabled: false,
    planGateEnabled: false,
    autoDrainEnabled: false, // keep pump() off → tick() exercises only the landing passes
    autoMergeEnabled: opts.autoMergeEnabled ?? true,
    buildQueueEnabled: false,
    draftMode: false,
    signoffAuthority: "human",
    maxAuto: 2,
    autoLabel: "shepherd:auto",
    priorityLabels: [],
    usageCeilingPct: 80,
    sandboxProfile: "trusted",
    defaultModel: "inherit",
    defaultEffort: "inherit",
    defaultExecutionEffort: "inherit",
    previewOpenMode: "ask",
    egressExtraHosts: [],
    egressIncludeStandard: "inherit" as const,
    repoMode: "forge",
    manualStepsIssueEnabled: false,
    preWarmEpicLandingCi: opts.preWarm ?? false,
    mergeWithoutCi: false,
    epicStacksEnabled: false,
    sharedBrowserEnabled: false,
    claudeAiConnectorsEnabled: false,
    browserAllowedHosts: [],
    hidden: false,
    pinned: false,
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
    openPrSnapshot: { peekCurrent: () => snapshot, get: async () => snapshot?.value ?? null },
    emitLandingGate: opts.emit === false ? undefined : (e) => gates.push(e),
    landingPrFallback: opts.fallback
      ? (_repo, f, branch) => (opts.fallback === "read" ? f.prStatus(branch) : null)
      : undefined,
  });

  const h: Harness = {
    store,
    drain,
    reads: () => reads,
    merges,
    reruns,
    rebases,
    gates,
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

function snapshotWith(status: PrStatus): OpenPrSnapshot {
  return { prs: [], statuses: new Map([[BRANCH, status]]), capped: false };
}

const PENDING = pr({ checks: "pending", runningChecks: ["ci / test"] });
const GREEN = pr({ checks: "success", mergeStateStatus: "clean" });

describe("no extra forge calls where a pass or snapshot covers it", () => {
  test("engaged repo, CI running: reads per tick are the same with and without the observer", async () => {
    const counts: number[] = [];
    for (const emit of [false, true]) {
      const h = makeHarness({ emit });
      h.setPr(PENDING);
      seedOpenLanding(h);
      await h.tickUntil(5 * TICK_MS);
      counts.push(h.reads());
    }
    expect(counts[1]).toBe(counts[0]!);
  });

  test("settled PR, unchanged fingerprint: 20 ticks push once and read no more than without it", async () => {
    const counts: number[] = [];
    let gates: CompletedEpic[] = [];
    for (const emit of [false, true]) {
      const h = makeHarness({ emit });
      seedOpenLanding(h);
      await h.tickUntil(19 * TICK_MS);
      counts.push(h.reads());
      gates = h.gates;
    }
    expect(counts[1]).toBe(counts[0]!);
    expect(gates).toHaveLength(1);
  });

  test("gap repo (no landing automation): 0 forge reads; pushes only from a current snapshot", async () => {
    const h = makeHarness({ autoMergeEnabled: false });
    seedOpenLanding(h);
    await h.tickUntil(10 * TICK_MS);
    expect(h.reads()).toBe(0);
    expect(h.gates).toHaveLength(0); // nothing read, nothing pushed

    h.setSnapshot({ at: h.now(), value: snapshotWith(GREEN) });
    await h.tickUntil(h.now() + 3 * TICK_MS);
    expect(h.reads()).toBe(0);
    expect(h.gates).toHaveLength(1);
    expect(h.gates[0]!.landingReady).toBe(true);
    expect(h.gates[0]!.landingChecks).toBe("success");
  });
});

describe("fallback read for a landing nothing else covers", () => {
  test("gap repo: the fallback reads it and the gate is pushed", async () => {
    const h = makeHarness({ autoMergeEnabled: false, fallback: "read" });
    h.setPr(GREEN);
    seedOpenLanding(h);
    await h.drain.tick();
    expect(h.reads()).toBe(1);
    expect(h.gates.map((g) => g.landingReady)).toEqual([true]);
  });

  test("gap repo with a current snapshot: the fallback is not used", async () => {
    const h = makeHarness({ autoMergeEnabled: false, fallback: "read" });
    h.setSnapshot({ at: 0, value: snapshotWith(GREEN) });
    seedOpenLanding(h);
    await h.tickUntil(3 * TICK_MS);
    expect(h.reads()).toBe(0);
    expect(h.gates).toHaveLength(1);
  });

  test("engaged repo: the passes' read serves it, the fallback adds nothing", async () => {
    const counts: number[] = [];
    for (const fallback of [undefined, "read"] as const) {
      const h = makeHarness({ fallback });
      h.setPr(PENDING);
      seedOpenLanding(h);
      await h.tickUntil(5 * TICK_MS);
      counts.push(h.reads());
    }
    expect(counts[1]).toBe(counts[0]!);
  });

  test("a skipped fallback (no client connected) reads nothing and pushes nothing", async () => {
    const h = makeHarness({ autoMergeEnabled: false, fallback: "skip" });
    seedOpenLanding(h);
    await h.tickUntil(5 * TICK_MS);
    expect(h.reads()).toBe(0);
    expect(h.gates).toHaveLength(0);
  });
});

describe("pushes", () => {
  test("a landing PR turning green is pushed on the next tick, ready to land", async () => {
    const h = makeHarness({ autoMergeEnabled: false });
    h.setSnapshot({ at: 0, value: snapshotWith(PENDING) });
    seedOpenLanding(h);
    await h.drain.tick();
    expect(h.gates.map((g) => g.landingChecks)).toEqual(["pending"]);
    h.setSnapshot({ at: TICK_MS, value: snapshotWith(GREEN) });
    h.setNow(TICK_MS);
    await h.drain.tick();
    expect(h.gates.map((g) => g.landingReady)).toEqual([false, true]);
    expect(h.gates[1]!.landingStrandedAt).toBeNumber();
  });

  test("a silent landing-progress write (repair count) is pushed", async () => {
    const h = makeHarness();
    seedOpenLanding(h);
    await h.drain.tick();
    expect(h.gates).toHaveLength(1);
    h.store.setEpicLandingRepairCount(REPO, PARENT, 1, "h1");
    h.setNow(TICK_MS);
    await h.drain.tick();
    expect(h.gates).toHaveLength(2);
    expect(h.gates[1]!.landingRepairCount).toBe(1);
    expect(h.gates[1]!.landingCiAutomation?.repair.used).toBe(1);
  });

  test("a manual CI-repair dispatch pushes the new gate before it answers", async () => {
    const h = makeHarness({ autoMergeEnabled: false, fallback: "read" });
    h.setPr(pr({ checks: "failure", mergeStateStatus: "unstable" }));
    seedOpenLanding(h);
    await h.drain.tick();
    expect(h.gates).toHaveLength(1);
    const res = await h.drain.repairLandingCi(REPO, PARENT);
    expect(res.ok).toBe(true);
    expect(h.gates).toHaveLength(2);
    expect(h.gates[1]!.landingRepairCount).toBe(1);
    expect(h.drain.pushedLandingGate(REPO, PARENT)?.landingRepairCount).toBe(1);
  });

  test("a failed read pushes nothing and keeps the last pushed state", async () => {
    const h = makeHarness();
    seedOpenLanding(h);
    await h.drain.tick();
    expect(h.gates).toHaveLength(1);
    h.setPr(new Error("gh down"));
    h.setKey("k2"); // force a fresh read
    h.setNow(TICK_MS);
    await h.drain.tick();
    expect(h.gates).toHaveLength(1);
    h.setPr(pr());
    h.setKey("k3");
    h.setNow(2 * TICK_MS);
    await h.drain.tick();
    expect(h.gates).toHaveLength(1); // same gate as before the failure
  });

  test("the pushed row is the public shape: no internal automation counters", async () => {
    const h = makeHarness();
    seedOpenLanding(h);
    await h.drain.tick();
    const g = h.gates[0] as unknown as Record<string, unknown>;
    expect(g.landingRerunCount).toBeUndefined();
    expect(g.childrenJson).toBeUndefined();
    expect(g.landingCiAutomation).toBeDefined();
  });
});
