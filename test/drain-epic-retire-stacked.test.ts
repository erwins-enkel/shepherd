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

// #2070 (epic #2063): bottom-up retire. #2061 refuses any stacked merge whose caller did not pass
// `allowStacked`, and `retireEpicChild` is autonomous — so the carve-out has to be exactly "the
// bottom-most unmerged layer", which lands one PR. Everything else holds, and holding happens in
// the DECISION so it can't eat the pump's single retire attempt.

const REPO = "/repo";
const PARENT = 2063;
const BOTTOM = 320;
const TOP = 321;
const OTHER = 400; // a second chain, so starvation is observable
const PR_BOTTOM = 900;
const PR_TOP = 901;
const PR_OTHER = 940;
const EPIC_BRANCH = "epic/2063-stack";
const BOTTOM_HEAD = `shepherd/auto-${BOTTOM}`;
const STACK_NUMBER = 7;

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
  merges: {
    prNumber: number;
    method: MergeMethod;
    deleteBranch: boolean;
    allowStacked?: boolean;
  }[];
}

interface ForgeOpts {
  /** Live stack membership bottom → top; defaults to the two composed layers. */
  stackPrNumbers?: number[];
  /** Base each PR reports; defaults to the epic branch (post auto-restack). */
  baseByPr?: Map<number, string>;
}

function fakeForge(rec: ForgeRec, opts: ForgeOpts = {}): GitForge {
  const subIssue = (number: number): SubIssueRef => ({
    number,
    title: `child ${number}`,
    url: `https://x/${number}`,
    body: "",
    closed: false,
    labels: [],
  });
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
      rec.merges.push({
        prNumber,
        method: o.method,
        deleteBranch: o.deleteBranch,
        ...(o.allowStacked === undefined ? {} : { allowStacked: o.allowStacked }),
      });
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
            title: "stack epic children",
            body: "epic body",
            url: `https://x/${PARENT}`,
            labels: [],
            createdAt: 0,
            assignees: [],
          }
        : null,
    listSubIssues: async () => [subIssue(BOTTOM), subIssue(TOP), subIssue(OTHER)],
    listBlockedBy: async (n: number) => (n === TOP ? [BOTTOM] : []),
    prReviewMeta: async (prNumber: number): Promise<PrReviewMeta | null> => ({
      body: "",
      baseRefName: opts.baseByPr?.get(prNumber) ?? EPIC_BRANCH,
      isCrossRepository: false,
      state: "open",
    }),
    stackForPr: async (prNumber: number): Promise<StackInfo | null> => {
      const prNumbers = opts.stackPrNumbers ?? [PR_BOTTOM, PR_TOP];
      return prNumbers.includes(prNumber)
        ? { number: STACK_NUMBER, baseRef: EPIC_BRANCH, prNumbers }
        : null;
    },
    createStack: async () => ({
      number: STACK_NUMBER,
      baseRef: EPIC_BRANCH,
      prNumbers: [PR_BOTTOM, PR_TOP],
    }),
    addToStack: async () => {},
    unstack: async () => {},
  };
}

interface Harness {
  store: SessionStore;
  drain: DrainService;
  forgeRec: ForgeRec;
  archived: string[];
  prCache: Record<string, GitState>;
  setReview: (id: string, decision: ReviewDecision, headSha: string) => void;
}

function makeHarness(opts: { stacksEnabled?: boolean } & ForgeOpts = {}): Harness {
  const store = new SessionStore(":memory:");
  store.setRepoConfig(REPO, {
    ...store.getRepoConfig(REPO),
    criticEnabled: true,
    autoDrainEnabled: true,
    maxAuto: 5,
    epicStacksEnabled: opts.stacksEnabled ?? true,
  });
  store.setEpicRun({
    repoPath: REPO,
    parentIssueNumber: PARENT,
    mode: "auto",
    status: "running",
  });
  // Pin the integration branch up front so the epic's children are judged against a stable name.
  store.getOrInitEpicIntegrationBranch(REPO, PARENT, EPIC_BRANCH);

  const forgeRec: ForgeRec = { merges: [] };
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

/** Seed one epic-child session. `mergeable: false` keeps it out of the retire gate while staying a
 *  live, mapped child (so it still counts as an unlanded layer below). */
function seedChild(
  h: Harness,
  issueNumber: number,
  prNumber: number,
  baseBranch: string,
  mergeable = true,
): Session {
  const s = h.store.create({
    name: "auto",
    prompt: "p",
    repoPath: REPO,
    baseBranch,
    branch: `shepherd/auto-${issueNumber}`,
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t",
    auto: true,
    issueNumber,
    epicParent: PARENT, // #2067: epic-child identity is a session fact, not a base-branch guess
  });
  h.prCache[s.id] = openGreen(prNumber, mergeable);
  h.setReview(s.id, "commented", `sha-${prNumber}`);
  return s;
}

function seedLayer(h: Harness, childNumber: number, prNumber: number, position: number): void {
  h.store.recordEpicStackMember(REPO, PARENT, {
    childNumber,
    stackNumber: STACK_NUMBER,
    prNumber,
    baseBranch: position === 1 ? EPIC_BRANCH : BOTTOM_HEAD,
    position,
  });
}

describe("stacked epic child retire (#2070)", () => {
  test("the bottom-most unmerged layer merges with allowStacked, keeping its head for the layer above", async () => {
    const h = makeHarness();
    const bottom = seedChild(h, BOTTOM, PR_BOTTOM, EPIC_BRANCH);
    seedChild(h, TOP, PR_TOP, BOTTOM_HEAD, false); // live successor, not retireable yet
    seedLayer(h, BOTTOM, PR_BOTTOM, 1);
    seedLayer(h, TOP, PR_TOP, 2);

    await h.drain.pump(REPO);

    expect(h.forgeRec.merges).toEqual([
      // deleteBranch false: the layer above is based on this head and may not have opened its PR.
      { prNumber: PR_BOTTOM, method: "squash", deleteBranch: false, allowStacked: true },
    ]);
    expect([...h.store.listEpicIntegrated(REPO, PARENT)]).toEqual([BOTTOM]);
    expect(h.store.get(bottom.id)?.status).toBe("archived");
  });

  test("a merged stacked layer records the PINNED branch, not its predecessor's head", async () => {
    // The layer above lands on the stack's TRUNK. Recording `s.baseBranch` here would make
    // divergenceWarnings (b) claim, permanently, that the child merged into a sibling's branch.
    const h = makeHarness();
    h.store.recordEpicIntegrated(REPO, PARENT, BOTTOM, { number: PR_BOTTOM, url: "" }, EPIC_BRANCH);
    seedChild(h, TOP, PR_TOP, BOTTOM_HEAD);
    seedLayer(h, BOTTOM, PR_BOTTOM, 1);
    seedLayer(h, TOP, PR_TOP, 2);

    await h.drain.pump(REPO);

    expect(h.forgeRec.merges).toEqual([
      { prNumber: PR_TOP, method: "squash", deleteBranch: true, allowStacked: true },
    ]);
    expect(
      h.store.listEpicIntegratedDetails(REPO, PARENT).find((d) => d.childNumber === TOP)
        ?.mergedBase,
    ).toBe(EPIC_BRANCH);
  });

  test("a layer whose predecessor has not landed does not merge", async () => {
    const h = makeHarness();
    seedChild(h, BOTTOM, PR_BOTTOM, EPIC_BRANCH, false); // in flight, not retireable
    const top = seedChild(h, TOP, PR_TOP, BOTTOM_HEAD);
    seedLayer(h, BOTTOM, PR_BOTTOM, 1);
    seedLayer(h, TOP, PR_TOP, 2);

    await h.drain.pump(REPO);

    expect(h.forgeRec.merges).toEqual([]);
    expect(h.store.get(top.id)?.status).not.toBe("archived");
    expect([...h.store.listEpicIntegrated(REPO, PARENT)]).toEqual([]);
  });

  test("a held layer does not consume the pump's retire attempt — a later chain still retires", async () => {
    // The held layer is created FIRST, so `retireDecision`'s createdAt-ordered .find hits it before
    // the other chain's ready child. Holding inside the retire action would end the pump here.
    const h = makeHarness();
    seedChild(h, BOTTOM, PR_BOTTOM, EPIC_BRANCH, false);
    const top = seedChild(h, TOP, PR_TOP, BOTTOM_HEAD);
    seedLayer(h, BOTTOM, PR_BOTTOM, 1);
    seedLayer(h, TOP, PR_TOP, 2);
    const other = seedChild(h, OTHER, PR_OTHER, EPIC_BRANCH); // second chain, unstacked

    await h.drain.pump(REPO);

    expect(h.forgeRec.merges).toEqual([
      { prNumber: PR_OTHER, method: "squash", deleteBranch: true },
    ]);
    expect(h.store.get(other.id)?.status).toBe("archived");
    expect(h.store.get(top.id)?.status).not.toBe("archived");
  });

  test("fails closed when the live stack carries a layer below us that is not a landed child", async () => {
    // The rows say we are bottom-most, but the host reports a foreign PR beneath us — merging would
    // land it too. Nothing merges, and the session stays live.
    const h = makeHarness({ stackPrNumbers: [999, PR_TOP] });
    const top = seedChild(h, TOP, PR_TOP, BOTTOM_HEAD);
    seedLayer(h, TOP, PR_TOP, 1);

    await h.drain.pump(REPO);

    expect(h.forgeRec.merges).toEqual([]);
    expect(h.store.get(top.id)?.status).not.toBe("archived");
  });

  test("epicStacksEnabled OFF: a recorded layer is ignored and the merge stays exactly as before", async () => {
    const h = makeHarness({ stacksEnabled: false });
    const bottom = seedChild(h, BOTTOM, PR_BOTTOM, EPIC_BRANCH);
    seedLayer(h, BOTTOM, PR_BOTTOM, 1);
    seedLayer(h, TOP, PR_TOP, 2);

    await h.drain.pump(REPO);

    expect(h.forgeRec.merges).toEqual([
      { prNumber: PR_BOTTOM, method: "squash", deleteBranch: true },
    ]);
    expect(
      h.store.listEpicIntegratedDetails(REPO, PARENT).find((d) => d.childNumber === BOTTOM)
        ?.mergedBase,
    ).toBe(EPIC_BRANCH);
    expect(h.store.get(bottom.id)?.status).toBe("archived");
  });
});
