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
  credits: null,
  stale: false,
  calibratedAt: null,
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
    egressExtraHosts: [],
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
    archive: (id: string): number => {
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
