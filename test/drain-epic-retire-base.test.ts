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
} from "../src/forge/types";
import { EMPTY_BACKLOG_COUNTS } from "../src/forge/types";
import type { CreateSessionInput, ReviewDecision, Session } from "../src/types";
import type { UsageLimits as UsageLimitsType } from "../src/usage-limits";

// #645 Task 2: retire enforces the child PR's base against the pinned epic integration branch.
// On mismatch it FAILS CLOSED — no merge, no integration, claim retained, marker parked, dependents
// stay blocked. Throttled via the marker. Gitea (no prReviewMeta) preserves today's behavior.

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
  reviewMetaCalls: number;
}

function fakeForge(
  rec: ForgeRec,
  opts: { baseRefName?: string; withReviewMeta?: boolean } = {},
): GitForge {
  const withReviewMeta = opts.withReviewMeta ?? true;
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
    listSubIssues: async () => [],
    listBlockedBy: async () => [],
  };
  if (withReviewMeta) {
    f.prReviewMeta = async (): Promise<PrReviewMeta> => {
      rec.reviewMetaCalls++;
      return {
        body: "",
        baseRefName: opts.baseRefName ?? EPIC_BRANCH,
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
  opts: { baseRefName?: string; withReviewMeta?: boolean; now?: () => number } = {},
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
  store.setEpicRun({
    repoPath: REPO,
    parentIssueNumber: PARENT,
    mode: "auto",
    status: "running",
  });

  const forgeRec: ForgeRec = { merges: [], reviewMetaCalls: 0 };
  const forge = fakeForge(forgeRec, {
    baseRefName: opts.baseRefName,
    withReviewMeta: opts.withReviewMeta,
  });

  const prCache: Record<string, GitState> = {};
  const reviews: Record<string, { decision: ReviewDecision; headSha: string }> = {};
  const archived: string[] = [];

  const service = {
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
  h.setReview(s.id, "commented", `sha-${PR}`);
  return s;
}

describe("epic child retire → PR base enforcement (#645 Task 2)", () => {
  test("matching base: merges as before, records integrated, clears any stale marker", async () => {
    const h = makeHarness({ baseRefName: EPIC_BRANCH });
    // pre-seed a stale marker to prove it is cleared on a successful (matching) retire
    h.store.recordEpicBaseMismatch(REPO, PARENT, CHILD, {
      actualBase: "main",
      prNumber: PR,
      checkedAt: 0,
    });
    const s = seedReadyChild(h, EPIC_BRANCH);

    await h.drain.pump(REPO);

    expect(h.forgeRec.reviewMetaCalls).toBe(1);
    expect(h.forgeRec.merges).toEqual([{ prNumber: PR, method: "squash", deleteBranch: true }]);
    expect([...h.store.listEpicIntegrated(REPO, PARENT)]).toContain(CHILD);
    expect(h.store.get(s.id)?.status).toBe("archived");
    expect(h.archived).toEqual([s.id]);
    expect(h.store.getEpicBaseMismatch(REPO, PARENT, CHILD)).toBeNull();
  });

  test("mismatched base: NOT merged, marker recorded, claim retained, dependents stay blocked", async () => {
    const h = makeHarness({ baseRefName: "main" }); // PR opened against default branch
    const s = seedReadyChild(h, EPIC_BRANCH);

    await h.drain.pump(REPO);

    expect(h.forgeRec.reviewMetaCalls).toBe(1);
    expect(h.forgeRec.merges).toHaveLength(0); // fail closed
    expect([...h.store.listEpicIntegrated(REPO, PARENT)]).not.toContain(CHILD);
    expect(h.store.get(s.id)?.status).not.toBe("archived");
    expect(h.archived).toHaveLength(0);
    const mm = h.store.getEpicBaseMismatch(REPO, PARENT, CHILD);
    expect(mm?.actualBase).toBe("main");
    expect(mm?.prNumber).toBe(PR);
    // surfaced through assembleEpic for the operator
    const epic = await h.drain.buildEpic(REPO, h.store.getEpicRun(REPO)!);
    expect(
      epic!.warnings.some(
        (w) => w.includes(`child #${CHILD}`) && w.includes("epic blocked until fixed"),
      ),
    ).toBe(true);
  });

  test("throttle: a fresh (<60s) marker skips the prReviewMeta call and stays blocked", async () => {
    let t = 1_000_000;
    const h = makeHarness({ baseRefName: "main", now: () => t });
    const s = seedReadyChild(h, EPIC_BRANCH);

    await h.drain.pump(REPO); // first pump: probes, records marker, blocks
    expect(h.forgeRec.reviewMetaCalls).toBe(1);
    expect(h.forgeRec.merges).toHaveLength(0);

    t += 30_000; // <60s later
    await h.drain.pump(REPO); // throttled: no new probe, still blocked
    expect(h.forgeRec.reviewMetaCalls).toBe(1);
    expect(h.forgeRec.merges).toHaveLength(0);
    expect(h.store.get(s.id)?.status).not.toBe("archived");

    t += 31_000; // now >60s since the marker → rechecks
    await h.drain.pump(REPO);
    expect(h.forgeRec.reviewMetaCalls).toBe(2);
  });

  test("Gitea (no prReviewMeta): merges as today, no base check, no marker", async () => {
    const h = makeHarness({ withReviewMeta: false });
    const s = seedReadyChild(h, EPIC_BRANCH);

    await h.drain.pump(REPO);

    expect(h.forgeRec.reviewMetaCalls).toBe(0);
    expect(h.forgeRec.merges).toEqual([{ prNumber: PR, method: "squash", deleteBranch: true }]);
    expect([...h.store.listEpicIntegrated(REPO, PARENT)]).toContain(CHILD);
    expect(h.store.get(s.id)?.status).toBe("archived");
    expect(h.store.getEpicBaseMismatch(REPO, PARENT, CHILD)).toBeNull();
  });
});

// Self-heal (#645 final review): a base-mismatch marker for a child resolved out-of-band — its PR
// merged into the default branch (issue closed) OR shepherd-integrated — never re-enters doRetire,
// so buildEpic must clear the now-orphaned marker (and drop its "epic blocked until fixed" warning).
// A still-open, not-done child's marker MUST persist.
describe("epic base-mismatch marker self-heal on buildEpic (#645)", () => {
  // Native epic so we control each child's closed-state + the integrated set directly. Children:
  // OPEN (blocked), ICLOSED (issue closed out-of-band), IINTEG (shepherd-integrated).
  const OPEN = 401;
  const ICLOSED = 402;
  const IINTEG = 403;

  function makeNativeHarness(): { store: SessionStore; drain: DrainService } {
    const store = new SessionStore(":memory:");
    store.setEpicRun({
      repoPath: REPO,
      parentIssueNumber: PARENT,
      mode: "auto",
      status: "running",
    });
    const sub = (number: number, closed: boolean) => ({
      number,
      title: `#${number}`,
      url: `https://x/${number}`,
      body: "",
      closed,
      labels: [] as string[],
    });
    const forge: GitForge = {
      ...fakeForge({ merges: [], reviewMetaCalls: 0 }),
      getIssue: async (n: number): Promise<Issue | null> =>
        n === PARENT
          ? {
              number: PARENT,
              title: "EFI cluster",
              body: "",
              url: `https://x/${PARENT}`,
              labels: [],
              createdAt: 0,
              assignees: [],
            }
          : null,
      listSubIssues: async () => [sub(OPEN, false), sub(ICLOSED, true), sub(IINTEG, false)],
      listBlockedBy: async () => [],
    };
    const service = {
      create: async (): Promise<Session> => {
        throw new Error("unused");
      },
      archive: async (): Promise<number> => 1,
    };
    const drain = new DrainService({
      store,
      service,
      resolveForge: () => forge,
      prCache: { snapshot: () => ({}) },
      usage: { limits: (): UsageLimitsType => NO_USAGE },
      repos: () => [REPO],
      emitStatus: () => {},
      emitArchived: () => {},
      dropPrCache: () => {},
      emitEpic: () => {},
      rebaseCap: 5,
    });
    return { store, drain };
  }

  test("clears markers for issue-closed AND integration-merged children; keeps the open one", async () => {
    const { store, drain } = makeNativeHarness();
    // IINTEG is shepherd-integrated; mark a base-mismatch on all three.
    store.recordEpicIntegrated(REPO, PARENT, IINTEG, { number: 510, url: "" }, EPIC_BRANCH);
    for (const c of [OPEN, ICLOSED, IINTEG]) {
      store.recordEpicBaseMismatch(REPO, PARENT, c, {
        actualBase: "main",
        prNumber: c + 100,
        checkedAt: 0,
      });
    }

    const epic = await drain.buildEpic(REPO, store.getEpicRun(REPO)!);

    // done-in-epic markers swept; open marker persists
    expect(store.getEpicBaseMismatch(REPO, PARENT, ICLOSED)).toBeNull();
    expect(store.getEpicBaseMismatch(REPO, PARENT, IINTEG)).toBeNull();
    expect(store.getEpicBaseMismatch(REPO, PARENT, OPEN)).not.toBeNull();

    // and the warnings reflect the sweep: only the open child is still "blocked until fixed"
    const blocked = (n: number) =>
      epic!.warnings.some(
        (w) => w.includes(`child #${n}`) && w.includes("epic blocked until fixed"),
      );
    expect(blocked(OPEN)).toBe(true);
    expect(blocked(ICLOSED)).toBe(false);
    expect(blocked(IINTEG)).toBe(false);
  });

  test("a marker for a still-open, not-done child persists across buildEpic", async () => {
    const { store, drain } = makeNativeHarness();
    store.recordEpicBaseMismatch(REPO, PARENT, OPEN, {
      actualBase: "main",
      prNumber: 501,
      checkedAt: 0,
    });

    const epic = await drain.buildEpic(REPO, store.getEpicRun(REPO)!);

    expect(store.getEpicBaseMismatch(REPO, PARENT, OPEN)?.actualBase).toBe("main");
    expect(
      epic!.warnings.some(
        (w) => w.includes(`child #${OPEN}`) && w.includes("epic blocked until fixed"),
      ),
    ).toBe(true);
  });
});
