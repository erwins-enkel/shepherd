/**
 * #3102 regression: a stacked epic child whose predecessor squash-merged into the epic branch
 * BEFORE the child opened its PR (aetherial M0: #61→#63, #66→#67). The child's PR targets a dead
 * branch; composition will not seed a stack on it and the retire gate refuses it forever. The
 * drain must re-target it onto the pinned epic branch and flip the session base, after which it
 * retires into the epic branch like any other child.
 */
import { test, expect, describe } from "bun:test";
import { DrainService } from "../src/drain";
import { SessionStore } from "../src/store";
import type {
  GitForge,
  GitState,
  Issue,
  MergeMethod,
  PrReviewMeta,
  PrStatus,
  StackInfo,
  SubIssueRef,
} from "../src/forge/types";
import { EMPTY_BACKLOG_COUNTS } from "../src/forge/types";
import type { StandardCreateInput, ReviewDecision, Session } from "../src/types";
import type { UsageLimits as UsageLimitsType } from "../src/usage-limits";

const REPO = "/repo";
const PARENT = 327;
const PRED = 319;
const CHILD = 320;
const PR = 330;
const EPIC_BRANCH = "epic/327-efi-cluster";
const PRED_BRANCH = `shepherd/auto-${PRED}`;

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
  retargets: { prNumber: number; base: string }[];
  containsChecks: { ref: string; headSha: string }[];
  reviewMetaCalls: number;
  /** #2069: PRs the gate asked the host to resolve a stack for. */
  stackReads: number[];
}

interface ForgeOpts {
  baseRefName?: string;
  withReviewMeta?: boolean;
  /** #2069: the stack the host reports for a PR (null ⇒ unstacked). Omit ⇒ no stack surface. */
  stackForPr?: (prNumber: number) => StackInfo | null;
  subIssues?: SubIssueRef[];
  blockedBy?: (issueNumber: number) => number[];
  /** Drop the retarget capability (Gitea/Local). */
  noRetarget?: boolean;
  retargetFails?: boolean;
  /** Does the child's head contain the dead base's tip? Default: yes. */
  contains?: boolean;
}

function fakeForge(rec: ForgeRec, opts: ForgeOpts = {}): GitForge {
  const withReviewMeta = opts.withReviewMeta ?? true;
  const liveBase = { value: opts.baseRefName ?? EPIC_BRANCH };
  const f: GitForge = {
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
    },
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
    listSubIssues: async () => opts.subIssues ?? [],
    listBlockedBy: async (n: number) => opts.blockedBy?.(n) ?? [],
  };
  if (opts.stackForPr) {
    f.stackForPr = async (prNumber: number) => {
      rec.stackReads.push(prNumber);
      return opts.stackForPr!(prNumber);
    };
    f.createStack = async (prNumbers: number[]) => ({ number: 7, baseRef: EPIC_BRANCH, prNumbers });
    f.addToStack = async () => {};
  }
  f.branchContains = async (ref: string, headSha: string) => {
    rec.containsChecks.push({ ref, headSha });
    return opts.contains ?? true;
  };
  if (!opts.noRetarget) {
    f.retargetPr = async (prNumber: number, base: string) => {
      if (opts.retargetFails) throw new Error("HTTP 422");
      rec.retargets.push({ prNumber, base });
      liveBase.value = base;
    };
  }
  if (withReviewMeta) {
    f.prReviewMeta = async (): Promise<PrReviewMeta> => {
      rec.reviewMetaCalls++;
      return {
        body: "",
        baseRefName: liveBase.value,
        isCrossRepository: false,
        state: "open",
      };
    };
  }
  return f;
}

interface Harness {
  store: SessionStore;
  drain: DrainService;
  forgeRec: ForgeRec;
  archived: string[];
  prCache: Record<string, GitState>;
  setReview: (id: string, d: ReviewDecision, sha: string) => void;
}

function makeHarness(
  opts: ForgeOpts & {
    now?: () => number;
    epicStacksEnabled?: boolean;
    restWritesBlocked?: () => boolean;
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
    epicStacksEnabled: opts.epicStacksEnabled ?? false,
    sharedBrowserEnabled: false,
    browserAllowedHosts: [],
    hidden: false,
  });
  store.setEpicRun({
    repoPath: REPO,
    parentIssueNumber: PARENT,
    mode: "auto",
    status: "running",
  });

  const forgeRec: ForgeRec = {
    merges: [],
    retargets: [],
    containsChecks: [],
    reviewMetaCalls: 0,
    stackReads: [],
  };
  const forge = fakeForge(forgeRec, opts);

  const prCache: Record<string, GitState> = {};
  const reviews: Record<string, { decision: ReviewDecision; headSha: string }> = {};
  const archived: string[] = [];

  const service = {
    create: async (input: StandardCreateInput): Promise<Session> =>
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
    emitStatus: () => {},
    emitArchived: (id) => archived.push(id),
    dropPrCache: () => {},
    emitEpic: () => {},
    now: opts.now,
    rebaseCap: 5,
    restWritesBlocked: opts.restWritesBlocked,
  });

  return {
    store,
    drain,
    forgeRec,
    archived,
    prCache,
    setReview: (id, decision, headSha) => {
      reviews[id] = { decision, headSha };
    },
  };
}

function openGreen(number: number): GitState {
  return {
    kind: "github",
    state: "open",
    number,
    checks: "success",
    mergeable: true,
    headSha: `sha-${number}`,
    deployConfigured: false,
  };
}

/** The predecessor: archived after its retire squash-merged it into the epic branch. */
function seedLandedPredecessor(h: Harness, integrated = true): Session {
  const p = h.store.create({
    name: "auto",
    prompt: "p",
    repoPath: REPO,
    baseBranch: EPIC_BRANCH,
    branch: PRED_BRANCH,
    worktreePath: "/wt-pred",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t",
    auto: true,
    issueNumber: PRED,
    epicParent: PARENT,
  });
  h.store.archive(p.id);
  if (integrated) {
    h.store.recordEpicIntegrated(REPO, PARENT, PRED, { number: 329, url: "" }, EPIC_BRANCH);
  }
  return p;
}

/** The child, spawned on the predecessor's head while its PR was still open. */
function seedStackedChild(h: Harness): Session {
  const s = h.store.create({
    name: "auto",
    prompt: "p",
    repoPath: REPO,
    baseBranch: PRED_BRANCH,
    branch: `shepherd/auto-${CHILD}`,
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t",
    auto: true,
    issueNumber: CHILD,
    epicParent: PARENT,
  });
  h.prCache[s.id] = openGreen(PR);
  h.setReview(s.id, "commented", `sha-${PR}`);
  return s;
}

const retargetPass = (h: Harness) =>
  (
    h.drain as unknown as { retargetDeadStackBasesForRepo(r: string): Promise<void> }
  ).retargetDeadStackBasesForRepo(REPO);

function pinned(h: Harness): void {
  h.store.getOrInitEpicIntegrationBranch(REPO, PARENT, EPIC_BRANCH);
}

describe("dead stacked base → re-target onto the epic branch (#3102)", () => {
  test("without the pass the child is blocked forever (the aetherial wedge)", async () => {
    const h = makeHarness({ baseRefName: PRED_BRANCH, epicStacksEnabled: true });
    pinned(h);
    seedLandedPredecessor(h);
    const s = seedStackedChild(h);

    await h.drain.pump(REPO);

    expect(h.forgeRec.merges).toHaveLength(0);
    expect(h.store.get(s.id)?.status).not.toBe("archived");
  });

  test("tick re-targets the PR, flips the session base, and the child retires into the epic", async () => {
    const h = makeHarness({ baseRefName: PRED_BRANCH, epicStacksEnabled: true });
    pinned(h);
    seedLandedPredecessor(h);
    const s = seedStackedChild(h);
    h.store.recordEpicBaseMismatch(REPO, PARENT, CHILD, {
      actualBase: PRED_BRANCH,
      prNumber: PR,
      checkedAt: Date.now(),
    });

    await retargetPass(h);

    expect(h.forgeRec.retargets).toEqual([{ prNumber: PR, base: EPIC_BRANCH }]);
    expect(h.store.get(s.id)?.baseBranch).toBe(EPIC_BRANCH);
    // The throttle marker is cleared so the retire re-checks at once.
    expect(h.store.getEpicBaseMismatch(REPO, PARENT, CHILD)).toBeNull();

    await h.drain.pump(REPO);

    expect(h.forgeRec.merges.map((m) => m.prNumber)).toEqual([PR]);
    expect([...h.store.listEpicIntegrated(REPO, PARENT)]).toContain(CHILD);
    expect(h.store.get(s.id)?.status).toBe("archived");

    // One-shot: a second pass finds nothing to do.
    await retargetPass(h);
    expect(h.forgeRec.retargets).toHaveLength(1);
  });

  test("runs with epicStacksEnabled OFF — a child spawned stacked stays stacked", async () => {
    const h = makeHarness({ baseRefName: PRED_BRANCH, epicStacksEnabled: false });
    pinned(h);
    seedLandedPredecessor(h);
    const s = seedStackedChild(h);

    await retargetPass(h);

    expect(h.forgeRec.retargets).toHaveLength(1);
    expect(h.store.get(s.id)?.baseBranch).toBe(EPIC_BRANCH);
  });

  test("PR already re-targeted by hand: adopts without a write", async () => {
    const h = makeHarness({ baseRefName: EPIC_BRANCH });
    pinned(h);
    seedLandedPredecessor(h);
    const s = seedStackedChild(h);

    await retargetPass(h);

    expect(h.forgeRec.retargets).toHaveLength(0);
    expect(h.store.get(s.id)?.baseBranch).toBe(EPIC_BRANCH);
  });

  test("predecessor NOT integrated: untouched (re-targeting would land its ungated commits)", async () => {
    const h = makeHarness({ baseRefName: PRED_BRANCH });
    pinned(h);
    seedLandedPredecessor(h, false);
    const s = seedStackedChild(h);

    await retargetPass(h);

    expect(h.forgeRec.retargets).toHaveLength(0);
    expect(h.forgeRec.reviewMetaCalls).toBe(0); // store-first: no forge call at all
    expect(h.store.get(s.id)?.baseBranch).toBe(PRED_BRANCH);
  });

  test("REST write backoff: no call", async () => {
    const h = makeHarness({ baseRefName: PRED_BRANCH, restWritesBlocked: () => true });
    pinned(h);
    seedLandedPredecessor(h);
    const s = seedStackedChild(h);

    await retargetPass(h);

    expect(h.forgeRec.retargets).toHaveLength(0);
    expect(h.store.get(s.id)?.baseBranch).toBe(PRED_BRANCH);
  });

  test("forge without retargetPr: no-op", async () => {
    const h = makeHarness({ baseRefName: PRED_BRANCH, noRetarget: true });
    pinned(h);
    seedLandedPredecessor(h);
    const s = seedStackedChild(h);

    await retargetPass(h);

    expect(h.forgeRec.reviewMetaCalls).toBe(0);
    expect(h.store.get(s.id)?.baseBranch).toBe(PRED_BRANCH);
  });

  test("host rejects the re-target: base kept, retry throttled", async () => {
    let now = 1_000_000;
    const h = makeHarness({ baseRefName: PRED_BRANCH, retargetFails: true, now: () => now });
    pinned(h);
    seedLandedPredecessor(h);
    const s = seedStackedChild(h);

    await retargetPass(h);
    await retargetPass(h);
    expect(h.forgeRec.reviewMetaCalls).toBe(1); // second pass throttled
    expect(h.store.get(s.id)?.baseBranch).toBe(PRED_BRANCH);

    now += 61_000;
    await retargetPass(h);
    expect(h.forgeRec.reviewMetaCalls).toBe(2);
  });

  test("child cut from an EARLIER predecessor head: held, never re-targeted (critic #1)", async () => {
    // The predecessor was reworked after the child branched; landing the child on the epic would
    // resurrect whatever that rework removed. It must stay blocked.
    const h = makeHarness({ baseRefName: PRED_BRANCH, contains: false });
    pinned(h);
    seedLandedPredecessor(h);
    const s = seedStackedChild(h);

    await retargetPass(h);

    expect(h.forgeRec.containsChecks).toEqual([{ ref: PRED_BRANCH, headSha: `sha-${PR}` }]);
    expect(h.forgeRec.retargets).toHaveLength(0);
    expect(h.store.get(s.id)?.baseBranch).toBe(PRED_BRANCH);
    await h.drain.pump(REPO);
    expect(h.forgeRec.merges).toHaveLength(0);
  });

  test("operator re-targeted a child that lacks the final tip: NOT adopted", async () => {
    const h = makeHarness({ baseRefName: EPIC_BRANCH, contains: false });
    pinned(h);
    seedLandedPredecessor(h);
    const s = seedStackedChild(h);

    await retargetPass(h);

    expect(h.store.get(s.id)?.baseBranch).toBe(PRED_BRANCH);
  });

  test("unknown head SHA: held without a compare call", async () => {
    const h = makeHarness({ baseRefName: PRED_BRANCH });
    pinned(h);
    seedLandedPredecessor(h);
    const s = seedStackedChild(h);
    h.prCache[s.id] = { ...h.prCache[s.id]!, headSha: undefined };

    await retargetPass(h);

    expect(h.forgeRec.containsChecks).toHaveLength(0);
    expect(h.store.get(s.id)?.baseBranch).toBe(PRED_BRANCH);
  });

  test("a candidate that cannot move is re-probed at most once a minute (critic #2)", async () => {
    let now = 1_000_000;
    // PR moved to some third branch → `none` every time.
    const h = makeHarness({ baseRefName: "main", now: () => now });
    pinned(h);
    seedLandedPredecessor(h);
    seedStackedChild(h);

    await retargetPass(h);
    await retargetPass(h);
    await retargetPass(h);
    expect(h.forgeRec.reviewMetaCalls).toBe(1);

    now += 61_000;
    await retargetPass(h);
    expect(h.forgeRec.reviewMetaCalls).toBe(2);
  });

  test("a held candidate is throttled too", async () => {
    const h = makeHarness({ baseRefName: PRED_BRANCH, contains: false, now: () => 1_000 });
    pinned(h);
    seedLandedPredecessor(h);
    seedStackedChild(h);

    await retargetPass(h);
    await retargetPass(h);

    expect(h.forgeRec.containsChecks).toHaveLength(1);
  });

  test("child without a PR yet: waits", async () => {
    const h = makeHarness({ baseRefName: PRED_BRANCH });
    pinned(h);
    seedLandedPredecessor(h);
    const s = seedStackedChild(h);
    delete h.prCache[s.id];

    await retargetPass(h);

    expect(h.forgeRec.reviewMetaCalls).toBe(0);
    expect(h.store.get(s.id)?.baseBranch).toBe(PRED_BRANCH);
  });
});

test("tick runs the pass", async () => {
  const h = makeHarness({ baseRefName: PRED_BRANCH });
  pinned(h);
  seedLandedPredecessor(h);
  const s = seedStackedChild(h);

  await h.drain.tick();

  expect(h.forgeRec.retargets).toEqual([{ prNumber: PR, base: EPIC_BRANCH }]);
  expect(h.store.get(s.id)?.baseBranch).toBe(EPIC_BRANCH);
});
