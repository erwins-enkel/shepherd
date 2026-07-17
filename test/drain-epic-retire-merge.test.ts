import { test, expect, describe } from "bun:test";
import { DrainService } from "../src/drain";
import { SessionStore } from "../src/store";
import type { GitForge, GitState, Issue, MergeMethod, PrStatus } from "../src/forge/types";
import { EMPTY_BACKLOG_COUNTS } from "../src/forge/types";
import type { CreateSessionInput, ReviewDecision, Session } from "../src/types";
import type { UsageLimits as UsageLimitsType } from "../src/usage-limits";

const REPO = "/repo";
const PARENT = 327;
const CHILD = 320;
const PR = 330;
const EPIC_BRANCH = "epic/327-efi-cluster";

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
  merges: { prNumber: number; method: MergeMethod; deleteBranch: boolean }[];
  links: { prNumber: number; issueNumber: number }[];
}

function fakeForge(rec: ForgeRec, opts: { merge?: () => Promise<void> } = {}): GitForge {
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
    merge: async (prNumber, o) => {
      rec.merges.push({ prNumber, method: o.method, deleteBranch: o.deleteBranch });
      if (opts.merge) await opts.merge();
    },
    redeploy: async () => {},
    postReview: async () => ({}),
    closeIssue: async () => {},
    ensureIssueLink: async (prNumber: number, issueNumber: number) => {
      rec.links.push({ prNumber, issueNumber });
    },
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
    // No sub-issues: the running epic spawns nothing new, leaving the drain free to retire the
    // ready child session we seed below.
    listSubIssues: async () => [],
    listBlockedBy: async () => [],
  };
}

interface Harness {
  store: SessionStore;
  drain: DrainService;
  forgeRec: ForgeRec;
  archived: string[];
  prCache: Record<string, GitState>;
}

function makeHarness(
  opts: {
    mergeImpl?: () => Promise<void>;
    epicStatus?: "running" | "paused" | "idle";
    archiveImpl?: (id: string) => number | Promise<number>;
  } = {},
): Harness {
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
  if (opts.epicStatus) {
    store.setEpicRun({
      repoPath: REPO,
      parentIssueNumber: PARENT,
      mode: "auto",
      status: opts.epicStatus,
    });
  }

  const forgeRec: ForgeRec = { merges: [], links: [] };
  const forge = fakeForge(forgeRec, { merge: opts.mergeImpl });

  const prCache: Record<string, GitState> = {};
  const reviews: Record<string, { decision: ReviewDecision; headSha: string }> = {};
  const archived: string[] = [];

  const service = {
    create: async (input: CreateSessionInput): Promise<Session> => {
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
      if (opts.archiveImpl) return opts.archiveImpl(id);
      store.archive(id);
      return 1;
    },
  };

  store.getReview = ((id: string) =>
    reviews[id]
      ? { decision: reviews[id].decision, headSha: reviews[id].headSha }
      : null) as typeof store.getReview;

  const harness: Harness = {
    store,
    drain: null as unknown as DrainService,
    forgeRec,
    archived,
    prCache,
  };
  // expose a review setter via closure
  (
    harness as Harness & { setReview: (id: string, d: ReviewDecision, sha: string) => void }
  ).setReview = (id, decision, headSha) => {
    reviews[id] = { decision, headSha };
  };

  const drain = new DrainService({
    store,
    service,
    resolveForge: () => forge,
    prCache: { snapshot: () => prCache },
    usage: { limits: (): UsageLimitsType => NO_USAGE },
    repos: () => [REPO],
    emitStatus: () => {},
    emitArchived: (id) => archived.push(id),
    dropPrCache: () => {},
    emitEpic: () => {},
    rebaseCap: 5,
  });
  harness.drain = drain;
  return harness;
}

function openGreen(number: number, mergeable = true): GitState {
  return {
    kind: "github",
    state: "open",
    number,
    checks: "success",
    mergeable,
    headSha: `sha-${number}`,
    deployConfigured: false,
  };
}

/** Seed a ready epic-child session: green+mergeable PR + clean critic verdict for its head. */
function seedReadyChild(h: Harness, baseBranch: string): Session {
  const s = h.store.create({
    name: "auto",
    prompt: "p",
    repoPath: REPO,
    baseBranch,
    branch: `shepherd/auto-${CHILD}`,
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t",
    auto: true,
    issueNumber: CHILD,
  });
  h.prCache[s.id] = openGreen(PR);
  (h as Harness & { setReview: (id: string, d: ReviewDecision, sha: string) => void }).setReview(
    s.id,
    "commented",
    `sha-${PR}`,
  );
  return s;
}

describe("epic child retire → squash-merge into integration branch", () => {
  test("ready epic child: forge.merge(squash, no-delete) into integration branch, records integrated, archives", async () => {
    const h = makeHarness({ epicStatus: "running" });
    const s = seedReadyChild(h, EPIC_BRANCH);

    await h.drain.pump(REPO);

    expect(h.forgeRec.merges).toEqual([{ prNumber: PR, method: "squash", deleteBranch: true }]);
    expect([...h.store.listEpicIntegrated(REPO, PARENT)]).toContain(CHILD);
    // #645 (b): the branch the child squash-merged into is recorded for divergence detection.
    expect(
      h.store.listEpicIntegratedDetails(REPO, PARENT).find((d) => d.childNumber === CHILD)
        ?.mergedBase,
    ).toBe(EPIC_BRANCH);
    expect(h.store.get(s.id)?.status).toBe("archived");
    expect(h.archived).toEqual([s.id]);
    // Epic child path does NOT auto-close-link the issue (no ensureIssueLink).
    expect(h.forgeRec.links).toHaveLength(0);
  });

  test("merge throws: does NOT record integrated and does NOT archive (session left live)", async () => {
    const h = makeHarness({
      epicStatus: "running",
      mergeImpl: async () => {
        throw new Error("merge conflict");
      },
    });
    const s = seedReadyChild(h, EPIC_BRANCH);

    await h.drain.pump(REPO);

    expect(h.forgeRec.merges).toHaveLength(1); // attempted
    expect([...h.store.listEpicIntegrated(REPO, PARENT)]).not.toContain(CHILD);
    expect(h.store.get(s.id)?.status).not.toBe("archived");
    expect(h.archived).toHaveLength(0);
  });

  test("non-epic ready session (base main): legacy path — no merge, ensureIssueLink + archive", async () => {
    // Epic active, but the session bases on main (not an integration branch) → legacy retire.
    const h = makeHarness({ epicStatus: "running" });
    const s = h.store.create({
      name: "auto",
      prompt: "p",
      repoPath: REPO,
      baseBranch: "main",
      branch: "shepherd/auto-7",
      worktreePath: "/wt",
      isolated: true,
      herdrSession: "default",
      herdrAgentId: "t",
      auto: true,
      issueNumber: 7,
    });
    h.prCache[s.id] = openGreen(70);
    (h as Harness & { setReview: (id: string, d: ReviewDecision, sha: string) => void }).setReview(
      s.id,
      "commented",
      "sha-70",
    );

    await h.drain.pump(REPO);

    expect(h.forgeRec.merges).toHaveLength(0); // drain never merges on the legacy path
    expect(h.forgeRec.links).toEqual([{ prNumber: 70, issueNumber: 7 }]);
    expect(h.store.get(s.id)?.status).toBe("archived");
    expect([...h.store.listEpicIntegrated(REPO, PARENT)]).not.toContain(7);
  });
});
