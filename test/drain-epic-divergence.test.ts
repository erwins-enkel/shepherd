import { test, expect, describe } from "bun:test";
import { DrainService } from "../src/drain";
import { SessionStore } from "../src/store";
import type { GitForge, GitState, Issue, PrStatus, SubIssueRef } from "../src/forge/types";
import { EMPTY_BACKLOG_COUNTS } from "../src/forge/types";
import type { CreateSessionInput, Session } from "../src/types";
import type { UsageLimits as UsageLimitsType } from "../src/usage-limits";

// #645 (c): drain.buildEpic scans the host for stray epic/* branches, throttled per epic,
// and surfaces each divergent branch (references the parent number, != pinned) as a warning.

const REPO = "/repo";
const PARENT = 327;
const PINNED = "epic/327-efi-cluster";

const NO_USAGE: UsageLimitsType = {
  session5h: null,
  week: null,
  perModelWeek: [],
  credits: null,
  stale: false,
  calibratedAt: null,
  subscriptionOnly: false,
};

type BranchesRef = { branches: string[]; calls: number; throws?: boolean };

function fakeForge(branchesRef: BranchesRef): GitForge {
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
    listSubIssues: async (n: number): Promise<SubIssueRef[]> =>
      n === PARENT
        ? [{ number: 320, title: "A", url: "u320", body: "", closed: false, labels: [] }]
        : [],
    listBlockedBy: async () => [],
    ensureBranch: async () => {},
    listBranches: async (prefix: string): Promise<string[]> => {
      branchesRef.calls++;
      if (branchesRef.throws) throw new Error("listBranches boom");
      return prefix === "epic/" ? branchesRef.branches : [];
    },
  };
}

function makeHarness(branchesRef: BranchesRef, clock: { t: number }) {
  const store = new SessionStore(":memory:");
  store.setRepoConfig(REPO, {
    criticEnabled: true,
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
    maxAuto: 5,
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
  store.setEpicRun({ repoPath: REPO, parentIssueNumber: PARENT, mode: "auto", status: "running" });
  // Pin the canonical name up front so divergence is measured against PINNED.
  store.getOrInitEpicIntegrationBranch(REPO, PARENT, PINNED);

  const forge = fakeForge(branchesRef);
  const drain = new DrainService({
    store,
    service: {
      create: async (input: CreateSessionInput): Promise<Session> =>
        store.create({
          name: "auto",
          prompt: input.prompt,
          repoPath: input.repoPath,
          baseBranch: input.baseBranch,
          branch: `shepherd/auto-${input.issueRef?.number ?? "x"}`,
          worktreePath: "/wt",
          isolated: true,
          herdrSession: "default",
          herdrAgentId: "t",
          auto: input.auto ?? false,
          issueNumber: input.issueRef?.number ?? null,
        }),
      archive: async (id: string): Promise<number> => {
        store.archive(id);
        return 1;
      },
    },
    resolveForge: () => forge,
    prCache: { snapshot: () => ({}) as Record<string, GitState> },
    usage: { limits: (): UsageLimitsType => NO_USAGE },
    repos: () => [REPO],
    now: () => clock.t,
    emitStatus: () => {},
    emitArchived: () => {},
    dropPrCache: () => {},
    rebaseCap: 5,
  });
  return { store, drain };
}

describe("epic-branch host divergence scan (#645 signal c)", () => {
  test("surfaces a divergent host branch + throttles the scan across builds", async () => {
    const branchesRef = {
      branches: [PINNED, "epic/efi-valuemap-327", "epic/1327-x"],
      calls: 0,
    };
    const clock = { t: 1_000 };
    const { store, drain } = makeHarness(branchesRef, clock);
    const run = store.getEpicRun(REPO)!;

    const e1 = await drain.buildEpic(REPO, run);
    expect(e1).not.toBeNull();
    // efi-valuemap-327 references 327 and != pinned → warned; 1327 is a numeric superstring → not.
    const divWarn = e1!.warnings.filter((w) => w.includes("divergent epic branch"));
    expect(divWarn).toHaveLength(1);
    expect(divWarn[0]).toContain("epic/efi-valuemap-327");
    expect(divWarn[0]).not.toContain("1327");
    expect(branchesRef.calls).toBe(1);

    // Second build within the TTL reuses the cache — no extra forge call.
    await drain.buildEpic(REPO, run);
    expect(branchesRef.calls).toBe(1);

    // Past the TTL → re-scans.
    clock.t += 6 * 60_000;
    await drain.buildEpic(REPO, run);
    expect(branchesRef.calls).toBe(2);
  });

  test("aligned host (only the pinned branch) → no divergence warning", async () => {
    const branchesRef = { branches: [PINNED], calls: 0 };
    const { store, drain } = makeHarness(branchesRef, { t: 0 });
    const run = store.getEpicRun(REPO)!;
    const e = await drain.buildEpic(REPO, run);
    expect(e!.warnings.some((w) => w.includes("divergent epic branch"))).toBe(false);
  });

  test("scan failure with no prior cache → empty list, buildEpic still succeeds", async () => {
    // listBranches throws on the very first call → the (c) scan falls back to [],
    // buildEpic does not throw, and no divergence warning is surfaced.
    const branchesRef = { branches: [PINNED, "epic/efi-valuemap-327"], calls: 0, throws: true };
    const { store, drain } = makeHarness(branchesRef, { t: 0 });
    const run = store.getEpicRun(REPO)!;

    const e = await drain.buildEpic(REPO, run);
    expect(e).not.toBeNull();
    expect(branchesRef.calls).toBe(1);
    // No cache to fall back to → empty → no (c) warning, while the epic itself still builds.
    expect(e!.warnings.some((w) => w.includes("divergent epic branch"))).toBe(false);
    expect(e!.parentIssueNumber).toBe(PARENT);
  });

  test("scan failure past the TTL → reuses the stale cached divergent list", async () => {
    // First a clean scan populates the cache with a divergent branch (warning present).
    const branchesRef = {
      branches: [PINNED, "epic/efi-valuemap-327"],
      calls: 0,
      throws: false,
    };
    const clock = { t: 1_000 };
    const { store, drain } = makeHarness(branchesRef, clock);
    const run = store.getEpicRun(REPO)!;

    const e1 = await drain.buildEpic(REPO, run);
    expect(e1!.warnings.filter((w) => w.includes("divergent epic branch"))).toHaveLength(1);
    expect(branchesRef.calls).toBe(1);

    // Past the TTL the scan re-fires, but now listBranches throws → the cached
    // divergent list is reused, so the (c) warning persists rather than vanishing.
    branchesRef.throws = true;
    clock.t += 6 * 60_000;
    const e2 = await drain.buildEpic(REPO, run);
    expect(branchesRef.calls).toBe(2); // re-scan was attempted (past TTL)
    const divWarn = e2!.warnings.filter((w) => w.includes("divergent epic branch"));
    expect(divWarn).toHaveLength(1);
    expect(divWarn[0]).toContain("epic/efi-valuemap-327");
  });
});
