/**
 * Tests for Task 5 — the landing-repair dispatch + branch-mutating-pass fences in drain.ts.
 *
 * When C's rerun budget (LANDING_RERUN_CAP) is spent on a terminally-red epic landing PR, the drain
 * dispatches ONE capped agent repair session (LANDING_REPAIR_CAP=1, durable via landingRepairCount)
 * that pushes directly to the pinned epic integration branch. While a genuinely-live repair session
 * holds that branch, the rerun (C), rebase, and auto-land passes must NOT touch it.
 */
import { test, expect, describe } from "bun:test";
import { DrainService } from "../src/drain";
import { SessionStore } from "../src/store";
import type { GitForge, Issue, PrStatus, SubIssueRef } from "../src/forge/types";
import { EMPTY_BACKLOG_COUNTS } from "../src/forge/types";
import type { UsageLimits as UsageLimitsType } from "../src/usage-limits";
import type { StandardCreateInput } from "../src/types";
import { epicIntegrationBranch } from "../src/epic-branch";
import { config } from "../src/config";

const REPO = "/repo";
const PARENT = 327;
const PARENT_TITLE = "EFI cluster";
const INTEGRATION_BRANCH = epicIntegrationBranch(PARENT, PARENT_TITLE); // epic/327-efi-cluster
const LANDING_PR = 555;
const LANDING_RERUN_CAP = 2; // mirror the drain constant (a fresh head resets it)

const NO_USAGE: UsageLimitsType = {
  session5h: null,
  week: null,
  perModelWeek: [],
  credits: null,
  stale: false,
  calibratedAt: null,
  subscriptionOnly: false,
};

/** A red (terminally failed CI), otherwise-landable PR — the repair target. */
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

/** A green, ready-to-land PR (the auto-land pass would merge it absent a fence). */
function greenPr(over: Partial<PrStatus> = {}): PrStatus {
  return { ...redPr(), checks: "success", ...over };
}

interface MergeCall {
  prNumber: number;
  deleteBranch: boolean | undefined;
}

interface ForgeSpy {
  forge: GitForge;
  prStatusCalls: string[];
  rerunCalls: number[];
  mergeCalls: MergeCall[];
}

function fakeForge(opts: {
  prStatus?: (branch: string) => Promise<PrStatus>;
  latestFailedRunForPr?: () => Promise<number | null>;
}): ForgeSpy {
  const prStatusCalls: string[] = [];
  const rerunCalls: number[] = [];
  const mergeCalls: MergeCall[] = [];

  const forge: GitForge = {
    kind: "github",
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
    merge: async (prNumber: number, o: { deleteBranch?: boolean }) => {
      mergeCalls.push({ prNumber, deleteBranch: o.deleteBranch });
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
    latestFailedRunForPr: opts.latestFailedRunForPr ?? (async () => 42),
    rerunWorkflowRun: async (runId: number) => {
      rerunCalls.push(runId);
    },
  };
  return { forge, prStatusCalls, rerunCalls, mergeCalls };
}

interface CreateCall {
  input: StandardCreateInput;
}

interface RepairCountCall {
  count: number;
  head: string | null;
}

interface Harness {
  store: SessionStore;
  drain: DrainService;
  spy: ForgeSpy;
  createCalls: CreateCall[];
  repairCountCalls: RepairCountCall[];
  sessionNews: unknown[];
  rebaseSeamCalls: number;
  rebaseStateCalls: unknown[];
}

function makeHarness(opts: {
  autoDrainEnabled?: boolean;
  autoMergeEnabled?: boolean;
  prStatus?: (branch: string) => Promise<PrStatus>;
  createThrows?: boolean;
  repoDefaultModel?: string;
  authMode?: "chatgpt" | "apikey" | "unknown";
  emitSessionNewThrows?: boolean;
  latestFailedRunForPr?: () => Promise<number | null>;
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
    draftMode: false,
    signoffAuthority: "human",
    maxAuto: 2,
    autoLabel: "shepherd:auto",
    usageCeilingPct: 80,
    sandboxProfile: "trusted",
    defaultModel: opts.repoDefaultModel ?? "inherit",
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
  const spy = fakeForge({
    prStatus: opts.prStatus,
    latestFailedRunForPr: opts.latestFailedRunForPr,
  });
  const createCalls: CreateCall[] = [];
  const repairCountCalls: RepairCountCall[] = [];
  const sessionNews: unknown[] = [];
  const harness = { rebaseSeamCalls: 0, rebaseStateCalls: [] as unknown[] };

  // Record every landingRepairCount write while preserving the real UPDATE.
  const origSetRepair = store.setEpicLandingRepairCount.bind(store);
  store.setEpicLandingRepairCount = (
    repoPath: string,
    parent: number,
    count: number,
    head: string | null,
    sessionId: string | null = null,
  ) => {
    repairCountCalls.push({ count, head });
    return origSetRepair(repoPath, parent, count, head, sessionId);
  };
  // Record every rebase-state write (a fence must not write pauseReason).
  const origSetRebase = store.setEpicLandingRebaseState.bind(store);
  store.setEpicLandingRebaseState = (repoPath: string, parent: number, patch: never) => {
    harness.rebaseStateCalls.push(patch);
    return origSetRebase(repoPath, parent, patch);
  };

  const drain = new DrainService({
    store,
    service: {
      create: async (input: StandardCreateInput) => {
        createCalls.push({ input });
        if (opts.createThrows) throw new Error("spawn refused (hold/egress/transient)");
        return { id: "repair-sess", baseBranch: input.baseBranch } as never;
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
    emitSessionNew: (s) => {
      sessionNews.push(s);
      if (opts.emitSessionNewThrows) throw new Error("listener blew up");
    },
    readCodexAuthMode: () => opts.authMode ?? "unknown",
    rebaseCap: 5,
    rebaseLandingBranch: async () => {
      harness.rebaseSeamCalls += 1;
      return { kind: "current" };
    },
  });

  return {
    store,
    drain,
    spy,
    createCalls,
    repairCountCalls,
    sessionNews,
    get rebaseSeamCalls() {
      return harness.rebaseSeamCalls;
    },
    get rebaseStateCalls() {
      return harness.rebaseStateCalls;
    },
  };
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

/** Add a genuinely-live landingRepair session holding the integration branch. */
function addLiveRepairSession(h: Harness): void {
  h.store.create({
    name: "repair",
    prompt: "repair the landing CI",
    repoPath: REPO,
    baseBranch: INTEGRATION_BRANCH,
    branch: INTEGRATION_BRANCH,
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t",
    auto: true,
    landingRepair: true,
  });
}

/** Pre-spend C's per-head rerun budget (persisted on the row, #2872) so the next rerun pass
 *  reaches the repair dispatch. */
function spendRerunBudget(h: Harness, head = "h1"): void {
  h.store.setEpicLandingRerun(REPO, PARENT, {
    head,
    count: LANDING_RERUN_CAP,
    unavailable: false,
  });
}

function callRerunPass(h: Harness): Promise<void> {
  const drain = h.drain as unknown as {
    landingPrs: { beginTick(): void };
    rerunRedLandingCiForRepo: (repoPath: string) => Promise<void>;
  };
  drain.landingPrs.beginTick(); // each call stands for its own drain tick (#2873)
  return drain.rerunRedLandingCiForRepo(REPO);
}

function callDoLandingRebase(h: Harness): Promise<void> {
  return (
    h.drain as unknown as {
      doLandingRebase: (
        repoPath: string,
        parent: number,
        row: {
          landingRebaseCount: number;
          landingRebaseDriverMisses: number;
          landingRebasePauseReason: "cap" | "conflict" | "driver" | null;
        },
        branch: string,
        defaultBranch: string,
      ) => Promise<void>;
    }
  ).doLandingRebase(
    REPO,
    PARENT,
    { landingRebaseCount: 0, landingRebaseDriverMisses: 0, landingRebasePauseReason: null },
    INTEGRATION_BRANCH,
    "main",
  );
}

function callTryAutoLand(h: Harness): Promise<void> {
  return (
    h.drain as unknown as {
      tryAutoLandEpic: (
        forge: GitForge,
        repoPath: string,
        parent: number,
        prNumber: number,
      ) => Promise<void>;
    }
  ).tryAutoLandEpic(h.spy.forge, REPO, PARENT, LANDING_PR);
}

// ── rerun (C) fence ─────────────────────────────────────────────────────────────

describe("landing-repair: rerun (C) fence", () => {
  test("live repair session on branch → no rerun, no repair spawn, no prStatus", async () => {
    const h = makeHarness({ autoDrainEnabled: true, prStatus: async () => redPr() });
    seedOpenLanding(h);
    addLiveRepairSession(h);

    await callRerunPass(h);

    expect(h.spy.rerunCalls).toHaveLength(0);
    expect(h.spy.prStatusCalls).toHaveLength(0);
    expect(h.createCalls).toHaveLength(0);
  });
});

// ── dispatch ────────────────────────────────────────────────────────────────────

describe("landing-repair: dispatch", () => {
  test("happy path: budget spent + red + autoDrain on + count 0 → one service.create + count bumped", async () => {
    const h = makeHarness({ autoDrainEnabled: true, prStatus: async () => redPr() });
    seedOpenLanding(h);
    spendRerunBudget(h);

    await callRerunPass(h);

    expect(h.createCalls).toHaveLength(1);
    const input = h.createCalls[0]!.input;
    expect(input.landingRepair).toBe(true);
    expect(input.baseBranch).toBe(INTEGRATION_BRANCH);
    expect(input.auto).toBe(true);
    expect(input.issueRef).toBeUndefined(); // never stamp the closed epic issue
    // Durable count incremented ONLY on a successful spawn, recording the PR head.
    expect(h.repairCountCalls).toEqual([{ count: 1, head: "h1" }]);
    // Pushed to the UI live, not only on the next full refresh.
    expect(h.sessionNews).toEqual([{ id: "repair-sess", baseBranch: INTEGRATION_BRANCH }]);
    // #2872: the session id is recorded for the landing card's "view session" link.
    expect(h.store.listEpicCompleted(REPO)[0]!.landingRepairSessionId).toBe("repair-sess");
  });

  test("#2872 prompt: names the red checks and allows a metadata fix via gh pr edit", async () => {
    const h = makeHarness({
      autoDrainEnabled: true,
      prStatus: async () =>
        redPr({
          jobs: [
            { name: "pr title", state: "failure", url: "https://github.com/o/r/runs/1" },
            { name: "verify / test", state: "success" },
          ],
        }),
    });
    seedOpenLanding(h);
    spendRerunBudget(h);

    await callRerunPass(h);

    const prompt = h.createCalls[0]!.input.prompt;
    expect(prompt).toContain("- pr title (https://github.com/o/r/runs/1)");
    expect(prompt).not.toContain("verify / test");
    expect(prompt).toContain(`gh pr edit ${LANDING_PR} --title`);
    expect(prompt).toContain(`git push origin HEAD:${INTEGRATION_BRANCH}`);
  });

  test("#2872 no rerunnable run on the head → escalates straight to the repair", async () => {
    const h = makeHarness({
      autoDrainEnabled: true,
      prStatus: async () => redPr(),
      latestFailedRunForPr: async () => null,
    });
    seedOpenLanding(h);

    await callRerunPass(h);

    expect(h.spy.rerunCalls).toHaveLength(0);
    expect(h.createCalls).toHaveLength(1);
    expect(h.store.listEpicCompleted(REPO)[0]!.landingRerunUnavailable).toBe(true);
  });

  test("throwing session:new listener: spawn still counts (budget bumped, no cooldown, no duplicate)", async () => {
    const h = makeHarness({
      autoDrainEnabled: true,
      prStatus: async () => redPr(),
      emitSessionNewThrows: true,
    });
    seedOpenLanding(h);
    spendRerunBudget(h);

    await callRerunPass(h);

    expect(h.createCalls).toHaveLength(1);
    expect(h.sessionNews).toHaveLength(1);
    expect(h.repairCountCalls).toEqual([{ count: 1, head: "h1" }]);
    const cooldown = (h.drain as unknown as { repairSpawnCooldown: Map<string, number> })
      .repairSpawnCooldown;
    expect(cooldown.size).toBe(0);

    spendRerunBudget(h);
    await callRerunPass(h);
    expect(h.createCalls).toHaveLength(1);
  });

  test("ChatGPT auth clamps a blocked Codex global default for landing repair", async () => {
    const savedProvider = config.defaultAgentProvider;
    const savedCodexModel = config.defaultCodexModel;
    config.defaultAgentProvider = "codex";
    config.defaultCodexModel = "gpt-5.3-codex";
    try {
      const h = makeHarness({
        autoDrainEnabled: true,
        prStatus: async () => redPr(),
        authMode: "chatgpt",
      });
      seedOpenLanding(h);
      spendRerunBudget(h);

      await callRerunPass(h);

      expect(h.createCalls[0]?.input.model).toBeNull();
    } finally {
      config.defaultAgentProvider = savedProvider;
      config.defaultCodexModel = savedCodexModel;
    }
  });

  test("inherits the selected provider's saved model", async () => {
    const savedProvider = config.defaultAgentProvider;
    const savedClaudeModel = config.defaultModel;
    const savedCodexModel = config.defaultCodexModel;
    config.defaultAgentProvider = "codex";
    config.defaultModel = "sonnet";
    config.defaultCodexModel = "gpt-5.4";
    try {
      const h = makeHarness({ autoDrainEnabled: true, prStatus: async () => redPr() });
      seedOpenLanding(h);
      spendRerunBudget(h);

      await callRerunPass(h);

      expect(h.createCalls[0]!.input.model).toBe("gpt-5.4");
    } finally {
      config.defaultAgentProvider = savedProvider;
      config.defaultModel = savedClaudeModel;
      config.defaultCodexModel = savedCodexModel;
    }
  });

  test("cap exhausted: landingRepairCount already 1 → no service.create", async () => {
    const h = makeHarness({ autoDrainEnabled: true, prStatus: async () => redPr() });
    seedOpenLanding(h);
    h.store.setEpicLandingRepairCount(REPO, PARENT, 1, "old");
    h.repairCountCalls.length = 0; // ignore the seed write
    spendRerunBudget(h);

    await callRerunPass(h);

    expect(h.createCalls).toHaveLength(0);
  });

  test("auto-drain off: engaged via autoMerge but autoDrain off → no service.create", async () => {
    const h = makeHarness({
      autoDrainEnabled: false,
      autoMergeEnabled: true,
      prStatus: async () => redPr(),
    });
    seedOpenLanding(h);
    spendRerunBudget(h);

    await callRerunPass(h);

    expect(h.createCalls).toHaveLength(0);
  });

  test("spawn refusal: create throws → count NOT burned, cooldown blocks the immediate retry", async () => {
    const h = makeHarness({
      autoDrainEnabled: true,
      prStatus: async () => redPr(),
      createThrows: true,
    });
    seedOpenLanding(h);
    spendRerunBudget(h);

    await callRerunPass(h);
    await callRerunPass(h); // immediate retry: cooldown must suppress a second dispatch

    expect(h.createCalls).toHaveLength(1); // exactly one attempt, then backed off
    expect(h.repairCountCalls).toHaveLength(0); // lifetime attempt NOT burned
    expect(h.sessionNews).toHaveLength(0); // no session → nothing pushed to the UI
  });
});

// ── rebase fence ────────────────────────────────────────────────────────────────

describe("landing-repair: rebase fence", () => {
  test("live repair session → rebaseLandingBranch seam NOT called, no pauseReason write", async () => {
    const h = makeHarness({ autoDrainEnabled: true, prStatus: async () => redPr() });
    seedOpenLanding(h);
    addLiveRepairSession(h);

    await callDoLandingRebase(h);

    expect(h.rebaseSeamCalls).toBe(0);
    expect(h.rebaseStateCalls).toHaveLength(0);
  });

  test("control: no live session → rebase seam runs", async () => {
    const h = makeHarness({ autoDrainEnabled: true, prStatus: async () => redPr() });
    seedOpenLanding(h);

    await callDoLandingRebase(h);

    expect(h.rebaseSeamCalls).toBe(1);
  });
});

// ── auto-land fence ─────────────────────────────────────────────────────────────

describe("landing-repair: auto-land fence", () => {
  test("live repair session → forge.merge NOT called", async () => {
    const h = makeHarness({ autoDrainEnabled: true, prStatus: async () => greenPr() });
    seedOpenLanding(h);
    addLiveRepairSession(h);

    await callTryAutoLand(h);

    expect(h.spy.mergeCalls).toHaveLength(0);
  });

  test("control: no live session + ready PR → forge.merge called", async () => {
    const h = makeHarness({ autoDrainEnabled: true, prStatus: async () => greenPr() });
    seedOpenLanding(h);

    await callTryAutoLand(h);

    expect(h.spy.mergeCalls).toEqual([{ prNumber: LANDING_PR, deleteBranch: true }]);
  });
});

// ── #2872: manual repair (the landing card's "Fix CI failures") ────────────────

describe("landing-repair: manual repairLandingCi", () => {
  test("bypasses auto-drain off, the exhausted cap and the spawn cooldown; bumps the count", async () => {
    const h = makeHarness({ autoDrainEnabled: false, prStatus: async () => redPr() });
    seedOpenLanding(h);
    h.store.setEpicLandingRepairCount(REPO, PARENT, 1, "old");
    h.repairCountCalls.length = 0;
    (h.drain as unknown as { repairSpawnCooldown: Map<string, number> }).repairSpawnCooldown.set(
      `${REPO}#${PARENT}`,
      Date.now(),
    );

    expect(await h.drain.repairLandingCi(REPO, PARENT)).toEqual({ ok: true });

    expect(h.createCalls).toHaveLength(1);
    expect(h.createCalls[0]!.input.landingRepair).toBe(true);
    expect(h.repairCountCalls).toEqual([{ count: 2, head: "h1" }]);
    expect(h.store.listEpicCompleted(REPO)[0]!.landingRepairSessionId).toBe("repair-sess");
  });

  test("refused while a live repair session holds the branch", async () => {
    const h = makeHarness({ prStatus: async () => redPr() });
    seedOpenLanding(h);
    addLiveRepairSession(h);

    expect(await h.drain.repairLandingCi(REPO, PARENT)).toEqual({
      ok: false,
      error: "repairing",
    });
    expect(h.createCalls).toHaveLength(0);
  });

  test("refused when the landing PR is no longer red", async () => {
    const h = makeHarness({ prStatus: async () => greenPr() });
    seedOpenLanding(h);

    expect(await h.drain.repairLandingCi(REPO, PARENT)).toEqual({ ok: false, error: "not-red" });
    expect(h.createCalls).toHaveLength(0);
  });

  test("busy while another landing pass holds the epic", async () => {
    const h = makeHarness({ prStatus: async () => redPr() });
    seedOpenLanding(h);
    (h.drain as unknown as { landingInFlight: Set<string> }).landingInFlight.add(
      `${REPO}#${PARENT}`,
    );

    expect(await h.drain.repairLandingCi(REPO, PARENT)).toEqual({ ok: false, error: "busy" });
  });

  test("no-landing without an open landing row; unsupported off GitHub", async () => {
    const h = makeHarness({ prStatus: async () => redPr() });
    expect(await h.drain.repairLandingCi(REPO, PARENT)).toEqual({
      ok: false,
      error: "no-landing",
    });

    seedOpenLanding(h);
    (h.spy.forge as { kind: string }).kind = "gitea";
    expect(await h.drain.repairLandingCi(REPO, PARENT)).toEqual({
      ok: false,
      error: "unsupported",
    });
  });

  test("spawn refusal → spawn-failed, count not burned", async () => {
    const h = makeHarness({ prStatus: async () => redPr(), createThrows: true });
    seedOpenLanding(h);

    expect(await h.drain.repairLandingCi(REPO, PARENT)).toEqual({
      ok: false,
      error: "spawn-failed",
    });
    expect(h.repairCountCalls).toHaveLength(0);
  });
});
