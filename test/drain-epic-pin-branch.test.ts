import { test, expect, describe } from "bun:test";
import { DrainService, type DrainStatus } from "../src/drain";
import { SessionStore } from "../src/store";
import type { GitForge, GitState, Issue, PrStatus, SubIssueRef } from "../src/forge/types";
import { EMPTY_BACKLOG_COUNTS } from "../src/forge/types";
import type { CreateSessionInput, ReviewDecision, Session } from "../src/types";
import type { UsageLimits as UsageLimitsType } from "../src/usage-limits";
import type { Epic } from "../src/epic-core";

// #645 regression: the integration-branch name is pinned on first use and read everywhere,
// so editing the epic's parent title mid-run must NOT re-point new child spawns (or, by the
// same token, the landing base). Without the pin, both follow the live title's fresh slug,
// orphaning children already merged on the original branch.

const REPO = "/repo";

const NO_USAGE: UsageLimitsType = {
  session5h: null,
  week: null,
  perModelWeek: [],
  credits: null,
  stale: false,
  calibratedAt: null,
  subscriptionOnly: false,
};

interface ForgeRec {
  ensured: { branch: string; fromRef: string }[];
}

function fakeForge(
  rec: ForgeRec,
  opts: {
    getIssue: (n: number) => Promise<Issue | null>;
    listSubIssues: (parentNumber: number) => Promise<SubIssueRef[]>;
    listBlockedBy: (issueNumber: number) => Promise<number[]>;
  },
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
    getIssue: opts.getIssue,
    listSubIssues: opts.listSubIssues,
    listBlockedBy: opts.listBlockedBy,
    ensureBranch: async (branch: string, fromRef: string) => {
      rec.ensured.push({ branch, fromRef });
    },
  };
}

function makeHarness(parentTitleRef: { title: string }, subIssues: SubIssueRef[]) {
  const PARENT = 327;
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

  const rec: ForgeRec = { ensured: [] };
  const forge = fakeForge(rec, {
    getIssue: async (n) =>
      n === PARENT
        ? {
            number: PARENT,
            title: parentTitleRef.title,
            body: "epic body",
            url: `https://x/${PARENT}`,
            labels: [],
            createdAt: 0,
            assignees: [],
          }
        : null,
    listSubIssues: async (n) => (n === PARENT ? subIssues : []),
    listBlockedBy: async () => [],
  });

  const prCache: Record<string, GitState> = {};
  const reviews: Record<string, { decision: ReviewDecision; headSha: string }> = {};
  const creates: CreateSessionInput[] = [];
  const statuses: DrainStatus[] = [];
  const epics: Epic[] = [];

  const service = {
    create: async (input: CreateSessionInput): Promise<Session> => {
      creates.push(input);
      return store.create({
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
      });
    },
    archive: async (id: string): Promise<number> => {
      store.archive(id);
      return 1;
    },
  };

  store.getReview = ((id: string) =>
    reviews[id]
      ? { decision: reviews[id].decision, headSha: reviews[id].headSha }
      : null) as typeof store.getReview;

  const drain = new DrainService({
    store,
    service,
    resolveForge: () => forge,
    prCache: { snapshot: () => prCache },
    usage: { limits: (): UsageLimitsType => NO_USAGE },
    repos: () => [REPO],
    emitStatus: (s) => statuses.push(s),
    emitArchived: () => {},
    dropPrCache: () => {},
    emitEpic: (epic) => epics.push(epic),
    rebaseCap: 5,
  });

  return { store, drain, rec, creates };
}

describe("epic integration branch is pinned across a title edit (#645)", () => {
  test("renaming the parent title mid-run does NOT re-point the spawn base", async () => {
    const titleRef = { title: "EFI cluster" };
    const subIssues: SubIssueRef[] = [
      { number: 320, title: "child A", url: "u320", body: "spec", closed: false, labels: [] },
      { number: 321, title: "child B", url: "u321", body: "spec", closed: false, labels: [] },
    ];
    const h = makeHarness(titleRef, subIssues);

    // First pump pins the branch from the original title + spawns the first child on it.
    await h.drain.pump(REPO);
    const PINNED = "epic/327-efi-cluster";
    expect(h.store.getEpicRun(REPO)).not.toBeNull();
    expect(h.creates.map((c) => c.baseBranch)).toContain(PINNED);
    const ensuredBranches = new Set(h.rec.ensured.map((e) => e.branch));
    expect(ensuredBranches).toEqual(new Set([PINNED]));

    // Operator renames the epic — the live title now slugs differently.
    titleRef.title = "Completely renamed thing";

    // Subsequent pump must still base every spawn on the originally-pinned branch.
    await h.drain.pump(REPO);
    for (const c of h.creates) expect(c.baseBranch).toBe(PINNED);
    // ensureBranch was never asked for the post-rename slug.
    expect(h.rec.ensured.map((e) => e.branch)).not.toContain("epic/327-completely-renamed-thing");

    // And the store still holds the original pinned name.
    expect(h.store.getOrInitEpicIntegrationBranch(REPO, 327, "epic/327-whatever-now")).toBe(PINNED);
  });
});
