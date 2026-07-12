import { test, expect, describe } from "bun:test";
import { DrainService, type DrainStatus } from "../src/drain";
import { ACTIVE_LABEL } from "../src/drain-core";
import { SessionStore } from "../src/store";
import type { GitForge, GitState, Issue, PrStatus, SubIssueRef } from "../src/forge/types";
import { EMPTY_BACKLOG_COUNTS } from "../src/forge/types";
import type { CreateSessionInput, ReviewDecision, Session } from "../src/types";
import type { UsageLimits as UsageLimitsType } from "../src/usage-limits";
import type { Epic } from "../src/epic-core";

const REPO = "/repo";

function issue(number: number, over: Partial<Issue> = {}): Issue {
  return {
    number,
    title: `issue ${number}`,
    body: `body ${number}`,
    url: `https://x/${number}`,
    labels: ["shepherd:auto"],
    createdAt: number,
    assignees: [],
    ...over,
  };
}

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
  listIssuesCalls: number;
  added: { number: number; label: string }[];
  /** ensureBranch calls: [branch, fromRef]. */
  ensured: { branch: string; fromRef: string }[];
}

function fakeForge(
  issues: Issue[],
  rec: ForgeRec,
  opts: {
    listIssues?: () => Promise<Issue[]>;
    getIssue?: (n: number) => Promise<Issue | null>;
    listSubIssues?: (parentNumber: number) => Promise<SubIssueRef[]>;
    listBlockedBy?: (issueNumber: number) => Promise<number[]>;
    ensureBranch?: (branch: string, fromRef: string) => Promise<void>;
    /** Omit the ensureBranch method entirely (e.g. a gitea forge that can't create refs). */
    noEnsureBranch?: boolean;
  } = {},
): GitForge {
  return {
    kind: "github",
    slug: "o/r",
    mergeMethod: "squash",
    deployWorkflow: null,
    listIssues: async () => {
      rec.listIssuesCalls++;
      if (opts.listIssues) return opts.listIssues();
      return issues;
    },
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
    addIssueLabel: async (number: number, label: string) => {
      rec.added.push({ number, label });
    },
    removeIssueLabel: async () => {},
    getIssue: async (number: number) => {
      if (opts.getIssue) return opts.getIssue(number);
      return issues.find((i) => i.number === number) ?? null;
    },
    listSubIssues: opts.listSubIssues,
    listBlockedBy: opts.listBlockedBy,
    ensureBranch: opts.noEnsureBranch
      ? undefined
      : async (branch: string, fromRef: string) => {
          rec.ensured.push({ branch, fromRef });
          if (opts.ensureBranch) await opts.ensureBranch(branch, fromRef);
        },
  };
}

interface Harness {
  store: SessionStore;
  drain: DrainService;
  forgeRec: ForgeRec;
  creates: CreateSessionInput[];
  statuses: DrainStatus[];
  epics: Epic[];
}

function makeHarness(
  opts: {
    issues?: Issue[];
    listIssuesImpl?: () => Promise<Issue[]>;
    getIssueImpl?: (n: number) => Promise<Issue | null>;
    listSubIssuesImpl?: (parentNumber: number) => Promise<SubIssueRef[]>;
    listBlockedByImpl?: (issueNumber: number) => Promise<number[]>;
    noEnsureBranch?: boolean;
  } = {},
): Harness {
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

  const forgeRec: ForgeRec = { listIssuesCalls: 0, added: [], ensured: [] };
  const forge = fakeForge(opts.issues ?? [], forgeRec, {
    listIssues: opts.listIssuesImpl,
    getIssue: opts.getIssueImpl,
    listSubIssues: opts.listSubIssuesImpl,
    listBlockedBy: opts.listBlockedByImpl,
    noEnsureBranch: opts.noEnsureBranch,
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

  const usage = { limits: (): UsageLimitsType => NO_USAGE };

  store.getReview = ((id: string) =>
    reviews[id]
      ? { decision: reviews[id].decision, headSha: reviews[id].headSha }
      : null) as typeof store.getReview;

  const drain = new DrainService({
    store,
    service,
    resolveForge: () => forge,
    prCache: { snapshot: () => prCache },
    usage,
    repos: () => [REPO],
    emitStatus: (s) => statuses.push(s),
    emitArchived: () => {},
    dropPrCache: () => {},
    emitEpic: (epic) => epics.push(epic),
    rebaseCap: 5,
  });

  return { store, drain, forgeRec, creates, statuses, epics };
}

describe("epic-child spawns base on the integration branch", () => {
  const PARENT = 327;
  const CHILD = 320;
  const EPIC_BRANCH = "epic/327-efi-cluster";

  test("running epic: ensureBranch(epic/327-efi-cluster, main) + spawn bases on it", async () => {
    const subIssues: SubIssueRef[] = [
      { number: CHILD, title: "EFI", url: "u320", body: "spec 320", closed: false, labels: [] },
    ];
    const parentIssue: Issue = {
      number: PARENT,
      title: "EFI cluster",
      body: "epic body",
      url: `https://x/${PARENT}`,
      labels: [],
      createdAt: 0,
      assignees: [],
    };
    const h = makeHarness({
      listIssuesImpl: async () => [],
      getIssueImpl: async (n) => (n === PARENT ? parentIssue : null),
      listSubIssuesImpl: async (n) => (n === PARENT ? subIssues : []),
      listBlockedByImpl: async () => [],
    });
    h.store.setEpicRun({
      repoPath: REPO,
      parentIssueNumber: PARENT,
      mode: "auto",
      status: "running",
    });

    await h.drain.pump(REPO);

    expect(h.forgeRec.ensured).toEqual([{ branch: EPIC_BRANCH, fromRef: "main" }]);
    expect(h.creates).toHaveLength(1);
    const created = h.creates[0]!;
    expect(created.baseBranch).toBe(EPIC_BRANCH);
    expect(created.issueRef?.number).toBe(CHILD);
    expect(created.agentProvider).toBeUndefined();
    // The spawn prompt carries the epic base directive so the agent opens its own PR
    // against the integration branch, not the default branch.
    expect(created.prompt).toContain(`--base ${EPIC_BRANCH}`);
    expect(created.prompt).toContain(EPIC_BRANCH);
  });

  test("running epic with explicit provider settings spawns the child with those settings", async () => {
    const subIssues: SubIssueRef[] = [
      { number: CHILD, title: "EFI", url: "u320", body: "spec 320", closed: false, labels: [] },
    ];
    const parentIssue: Issue = {
      number: PARENT,
      title: "EFI cluster",
      body: "epic body",
      url: `https://x/${PARENT}`,
      labels: [],
      createdAt: 0,
      assignees: [],
    };
    const h = makeHarness({
      listIssuesImpl: async () => [],
      getIssueImpl: async (n) => (n === PARENT ? parentIssue : null),
      listSubIssuesImpl: async (n) => (n === PARENT ? subIssues : []),
      listBlockedByImpl: async () => [],
    });
    h.store.setEpicRun({
      repoPath: REPO,
      parentIssueNumber: PARENT,
      mode: "auto",
      status: "running",
      agentProvider: "codex",
      model: "gpt-5.5",
      effort: "high",
    });

    await h.drain.pump(REPO);

    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]).toMatchObject({
      agentProvider: "codex",
      model: "gpt-5.5",
      effort: "high",
      issueRef: { number: CHILD },
    });
  });

  test("running epic on a forge WITHOUT ensureBranch: falls back to main, never the epic branch", async () => {
    const subIssues: SubIssueRef[] = [
      { number: CHILD, title: "EFI", url: "u320", body: "spec 320", closed: false, labels: [] },
    ];
    const parentIssue: Issue = {
      number: PARENT,
      title: "EFI cluster",
      body: "epic body",
      url: `https://x/${PARENT}`,
      labels: [],
      createdAt: 0,
      assignees: [],
    };
    const h = makeHarness({
      noEnsureBranch: true,
      listIssuesImpl: async () => [],
      getIssueImpl: async (n) => (n === PARENT ? parentIssue : null),
      listSubIssuesImpl: async (n) => (n === PARENT ? subIssues : []),
      listBlockedByImpl: async () => [],
    });
    h.store.setEpicRun({
      repoPath: REPO,
      parentIssueNumber: PARENT,
      mode: "auto",
      status: "running",
    });

    await h.drain.pump(REPO);

    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]!.baseBranch).toBe("main"); // fallback, NOT the epic branch
    expect(h.creates[0]!.issueRef?.number).toBe(CHILD);
    expect(h.forgeRec.ensured).toHaveLength(0);
    // Fell back to main → did NOT use the integration branch, so no epic directive.
    expect(h.creates[0]!.prompt).not.toContain("--base");
    expect(h.creates[0]!.prompt).not.toContain("part of an epic");
  });

  test("regular label-drain spawn: bases on main, never ensures a branch", async () => {
    const h = makeHarness({ issues: [issue(1)] });
    await h.drain.pump(REPO);
    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]!.baseBranch).toBe("main");
    expect(h.creates[0]!.agentProvider).toBeUndefined();
    expect(h.forgeRec.ensured).toHaveLength(0);
    expect(h.forgeRec.added).toEqual([{ number: 1, label: ACTIVE_LABEL }]);
    // Regular spawn → prompt is just the title, no --base directive.
    expect(h.creates[0]!.prompt).not.toContain("--base");
  });
});
