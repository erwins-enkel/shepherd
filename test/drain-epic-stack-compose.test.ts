/**
 * Tests for the #2069 stack-composition pass — `composeEpicStacksForRepo` in drain.ts.
 *
 * The pass links an epic's child PRs into a GitHub stack rooted at the epic's PINNED integration
 * branch. It is opt-in (`epicStacksEnabled`), running-only, capability-gated (a forge without the
 * #2068 stack surface is skipped), throttled, and takes at most ONE step per pass.
 *
 * The load-bearing rule is that the BOTTOM layer's base is the stack's trunk: seeding on a child
 * whose PR targets `main` would root the whole stack — every layer above it included — at `main`.
 */
import { test, expect, describe } from "bun:test";
import { DrainService } from "../src/drain";
import { SessionStore } from "../src/store";
import type {
  GitForge,
  GitState,
  Issue,
  PrReviewMeta,
  PrStatus,
  StackInfo,
  SubIssueRef,
} from "../src/forge/types";
import { EMPTY_BACKLOG_COUNTS } from "../src/forge/types";
import type { UsageLimits as UsageLimitsType } from "../src/usage-limits";
import { epicIntegrationBranch } from "../src/epic-branch";

const REPO = "/repo";
const PARENT = 327;
const PARENT_TITLE = "EFI cluster";
const EPIC_BRANCH = epicIntegrationBranch(PARENT, PARENT_TITLE); // epic/327-efi-cluster
const LOWER = 320;
const MIDDLE = 321;
const UPPER = 322;
const PR_OF: Record<number, number> = { [LOWER]: 900, [MIDDLE]: 901, [UPPER]: 902 };
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
  created: number[][];
  added: { stackNumber: number; prNumber: number }[];
  stackReads: number[];
  reviewMetaCalls: number[];
  unstacked: number[];
}

interface ForgeOpts {
  /** Host stack for a PR (null ⇒ unstacked, the default). */
  stackForPr?: (prNumber: number) => StackInfo | null;
  /** Live base of a PR — the bottom layer's is the trunk-to-be. */
  baseRefName?: (prNumber: number) => string;
  /** Drop the whole stacked-PR surface (Gitea/Local). */
  noStacks?: boolean;
}

function fakeForge(rec: ForgeRec, opts: ForgeOpts = {}): GitForge {
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
    merge: async () => {},
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
            title: PARENT_TITLE,
            body: "epic body",
            url: `https://x/${PARENT}`,
            labels: [],
            createdAt: 0,
            assignees: [],
          }
        : null,
    listSubIssues: async (n: number): Promise<SubIssueRef[]> =>
      n === PARENT
        ? [LOWER, MIDDLE, UPPER].map((number) => ({
            number,
            title: `child ${number}`,
            url: `u${number}`,
            body: "",
            closed: false,
            labels: [],
          }))
        : [],
    listBlockedBy: async (n: number) => (n === MIDDLE ? [LOWER] : n === UPPER ? [MIDDLE] : []),
    prReviewMeta: async (prNumber: number): Promise<PrReviewMeta> => {
      rec.reviewMetaCalls.push(prNumber);
      return {
        body: "",
        baseRefName: opts.baseRefName?.(prNumber) ?? EPIC_BRANCH,
        isCrossRepository: false,
        state: "open",
      };
    },
  };
  if (!opts.noStacks) {
    f.stackForPr = async (prNumber: number) => {
      rec.stackReads.push(prNumber);
      return opts.stackForPr?.(prNumber) ?? null;
    };
    f.createStack = async (prNumbers: number[]) => {
      rec.created.push(prNumbers);
      return { number: STACK_NUMBER, baseRef: EPIC_BRANCH, prNumbers };
    };
    f.addToStack = async (stackNumber: number, prNumber: number) => {
      rec.added.push({ stackNumber, prNumber });
    };
    f.unstack = async (stackNumber: number) => {
      rec.unstacked.push(stackNumber);
    };
  }
  return f;
}

interface Harness {
  store: SessionStore;
  drain: DrainService;
  rec: ForgeRec;
  /** Live PR snapshot, mutable so a test can close a child's PR mid-flight. */
  prCache: Record<string, GitState>;
  /** child issue number → session id. */
  sessionOf: Record<number, string>;
}

function makeHarness(
  opts: ForgeOpts & {
    epicStacks?: boolean;
    epicStatus?: "running" | "idle" | "paused";
    /** Children that have an open PR (default: the bottom two). */
    withPr?: number[];
    pin?: boolean;
    now?: () => number;
  } = {},
): Harness {
  const store = new SessionStore(":memory:");
  store.setRepoConfig(REPO, {
    criticEnabled: false,
    criticAllPrs: false,
    criticSmellLensEnabled: false,
    autoAddressEnabled: false,
    learningsEnabled: false,
    autopilotEnabled: false,
    planGateEnabled: false,
    autoDrainEnabled: false,
    autoMergeEnabled: false,
    buildQueueEnabled: false,
    draftMode: false,
    signoffAuthority: "human",
    maxAuto: 3,
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
    epicStacksEnabled: opts.epicStacks ?? true,
    hidden: false,
  });
  store.setEpicRun({
    repoPath: REPO,
    parentIssueNumber: PARENT,
    mode: "auto",
    status: opts.epicStatus ?? "running",
  });
  if (opts.pin !== false) store.getOrInitEpicIntegrationBranch(REPO, PARENT, EPIC_BRANCH);

  // One live session per child; the ones in `withPr` also have an open PR in the cache.
  const prCache: Record<string, GitState> = {};
  const sessionOf: Record<number, string> = {};
  const withPr = new Set(opts.withPr ?? [LOWER, MIDDLE]);
  for (const child of [LOWER, MIDDLE, UPPER]) {
    const s = store.create({
      name: "auto",
      prompt: "p",
      repoPath: REPO,
      baseBranch: child === LOWER ? EPIC_BRANCH : `shepherd/auto-${child - 1}`,
      branch: `shepherd/auto-${child}`,
      worktreePath: "/wt",
      isolated: true,
      herdrSession: "default",
      herdrAgentId: "t",
      auto: true,
      issueNumber: child,
      epicParent: PARENT,
    });
    sessionOf[child] = s.id;
    if (withPr.has(child)) {
      prCache[s.id] = {
        kind: "github",
        state: "open",
        number: PR_OF[child]!,
        checks: "success",
        deployConfigured: false,
      };
    }
  }

  const rec: ForgeRec = {
    created: [],
    added: [],
    stackReads: [],
    reviewMetaCalls: [],
    unstacked: [],
  };
  const forge = fakeForge(rec, opts);
  const drain = new DrainService({
    store,
    service: {
      create: async () => {
        throw new Error("not used");
      },
      archive: () => 1,
    } as never,
    resolveForge: () => forge,
    prCache: { snapshot: () => prCache },
    usage: { limits: (): UsageLimitsType => NO_USAGE },
    repos: () => [REPO],
    emitStatus: () => {},
    emitArchived: () => {},
    dropPrCache: () => {},
    emitEpic: () => {},
    now: opts.now,
    rebaseCap: 5,
  });
  return { store, drain, rec, prCache, sessionOf };
}

/** Invoke the private pass directly, so nothing else in tick() colours the assertions. */
function compose(h: Harness): Promise<void> {
  return (
    h.drain as unknown as { composeEpicStacksForRepo: (repoPath: string) => Promise<void> }
  ).composeEpicStacksForRepo(REPO);
}

const layers = (h: Harness) =>
  h.store.listEpicStack(REPO, PARENT).map((r) => [r.childNumber, r.prNumber, r.position]);

describe("composeEpicStacksForRepo (#2069)", () => {
  test("seeds the stack from the bottom two child PRs and records both layers", async () => {
    const h = makeHarness();

    await compose(h);

    expect(h.rec.created).toEqual([[PR_OF[LOWER]!, PR_OF[MIDDLE]!]]);
    expect(layers(h)).toEqual([
      [LOWER, PR_OF[LOWER]!, 1],
      [MIDDLE, PR_OF[MIDDLE]!, 2],
    ]);
    // The recorded base is what the child was actually built on.
    expect(h.store.listEpicStack(REPO, PARENT)[0]?.baseBranch).toBe(EPIC_BRANCH);
  });

  test("refuses to seed when the bottom PR does not target the pinned epic branch", async () => {
    // The bottom layer's base IS the trunk: seeding here would root the stack at main.
    const h = makeHarness({ baseRefName: (pr) => (pr === PR_OF[LOWER] ? "main" : EPIC_BRANCH) });

    await compose(h);

    expect(h.rec.created).toHaveLength(0);
    expect(layers(h)).toEqual([]);
  });

  test("extends an existing stack by one layer once the next child opens its PR", async () => {
    let t = 1_000_000;
    const h = makeHarness({ withPr: [LOWER, MIDDLE, UPPER], now: () => t });

    await compose(h); // seeds 320+321
    t += 120_000; // past the compose throttle
    await compose(h); // extends with 322

    expect(h.rec.created).toEqual([[PR_OF[LOWER]!, PR_OF[MIDDLE]!]]);
    expect(h.rec.added).toEqual([{ stackNumber: STACK_NUMBER, prNumber: PR_OF[UPPER]! }]);
    expect(layers(h)).toEqual([
      [LOWER, PR_OF[LOWER]!, 1],
      [MIDDLE, PR_OF[MIDDLE]!, 2],
      [UPPER, PR_OF[UPPER]!, 3],
    ]);
  });

  test("throttled: an immediate second pass makes no host calls", async () => {
    const h = makeHarness({ withPr: [LOWER, MIDDLE, UPPER] });

    await compose(h);
    const readsAfterFirst = h.rec.stackReads.length;
    await compose(h);

    expect(h.rec.stackReads).toHaveLength(readsAfterFirst);
    expect(h.rec.created).toHaveLength(1);
    expect(h.rec.added).toHaveLength(0);
  });

  test("idempotent: a fully composed chain plans nothing further", async () => {
    let t = 1_000_000;
    const h = makeHarness({ now: () => t });

    await compose(h);
    t += 120_000;
    await compose(h);

    expect(h.rec.created).toHaveLength(1);
    expect(h.rec.added).toHaveLength(0);
    expect(layers(h)).toHaveLength(2);
  });

  test("adopts a stack the host already has instead of creating a second one", async () => {
    // e.g. the process died between createStack and the row write.
    const h = makeHarness({
      stackForPr: (pr) =>
        pr === PR_OF[LOWER]
          ? { number: 42, baseRef: EPIC_BRANCH, prNumbers: [PR_OF[LOWER]!, PR_OF[MIDDLE]!] }
          : null,
    });

    await compose(h);

    expect(h.rec.created).toHaveLength(0);
    expect(h.store.listEpicStack(REPO, PARENT).map((r) => r.stackNumber)).toEqual([42, 42]);
    expect(layers(h)).toEqual([
      [LOWER, PR_OF[LOWER]!, 1],
      [MIDDLE, PR_OF[MIDDLE]!, 2],
    ]);
  });

  test("a stack rooted somewhere else is left alone — repair is not a side effect", async () => {
    const h = makeHarness({
      stackForPr: (pr) =>
        pr === PR_OF[LOWER]
          ? { number: 42, baseRef: "main", prNumbers: [PR_OF[LOWER]!, PR_OF[MIDDLE]!] }
          : null,
    });

    await compose(h);

    expect(h.rec.created).toHaveLength(0);
    expect(h.rec.added).toHaveLength(0);
    expect(layers(h)).toEqual([]);
  });

  test("a done MIDDLE layer is not spliced over — the chain is cut, not filtered", async () => {
    // 321 already integrated; 320 and 322 both have open PRs. Stacking 322 on 320 would link two
    // PRs that are not actually based on one another.
    const h = makeHarness({ withPr: [LOWER, MIDDLE, UPPER] });
    h.store.recordEpicIntegrated(REPO, PARENT, MIDDLE, { number: PR_OF[MIDDLE]!, url: "u" });

    await compose(h);

    expect(h.rec.created).toHaveLength(0);
    expect(h.rec.added).toHaveLength(0);
    expect(layers(h)).toEqual([]);
  });

  test("one child PR is not a stack — nothing to compose", async () => {
    const h = makeHarness({ withPr: [LOWER] });

    await compose(h);

    expect(h.rec.stackReads).toHaveLength(0);
    expect(h.rec.created).toHaveLength(0);
  });

  test("flag OFF: no host call at all", async () => {
    const h = makeHarness({ epicStacks: false });

    await compose(h);

    expect(h.rec.stackReads).toHaveLength(0);
    expect(h.rec.created).toHaveLength(0);
    expect(h.rec.reviewMetaCalls).toHaveLength(0);
  });

  test("forge without the stack surface: skipped", async () => {
    const h = makeHarness({ noStacks: true });

    await compose(h);

    expect(h.rec.reviewMetaCalls).toHaveLength(0);
    expect(layers(h)).toEqual([]);
  });

  test("epic not running: skipped", async () => {
    const h = makeHarness({ epicStatus: "paused" });

    await compose(h);

    expect(h.rec.stackReads).toHaveLength(0);
  });

  test("unpinned epic: skipped (nothing has been based on a branch yet)", async () => {
    const h = makeHarness({ pin: false });

    await compose(h);

    expect(h.rec.stackReads).toHaveLength(0);
  });

  test("wired into tick(): a running flagged epic composes without an explicit call", async () => {
    const h = makeHarness();

    await h.drain.tick();

    expect(h.rec.created).toEqual([[PR_OF[LOWER]!, PR_OF[MIDDLE]!]]);
  });
});

/**
 * #2070 — mid-stack loss. A closed or abandoned middle layer blocks every layer above it, and
 * GitHub has no reorder or drop-one endpoint, so the only repair primitive is unstack-and-recreate.
 * The repair runs inside the same pass as composition, which is why it lives in this file.
 *
 * The load-bearing detail is WHAT counts as a lost layer: an abandon releases the claim and pumps
 * immediately, so the child is re-spawned with a fresh session and PR long before this pass next
 * runs. The child then looks healthy while the recorded LAYER is orphaned — so the detector keys on
 * the row's PR, never on child liveness.
 */
describe("mid-stack loss repair (#2070)", () => {
  const STALE_PR = 899; // the layer PR the stack was built on, before the child was re-spawned

  /** Seed a three-layer stack whose MIDDLE row names `middlePr`. */
  function seedStack(h: Harness, middlePr: number): void {
    const rows: [number, number, number][] = [
      [LOWER, PR_OF[LOWER]!, 1],
      [MIDDLE, middlePr, 2],
      [UPPER, PR_OF[UPPER]!, 3],
    ];
    for (const [childNumber, prNumber, position] of rows) {
      h.store.recordEpicStackMember(REPO, PARENT, {
        childNumber,
        stackNumber: STACK_NUMBER,
        prNumber,
        baseBranch: position === 1 ? EPIC_BRANCH : `shepherd/auto-${childNumber - 1}`,
        position,
      });
    }
  }

  const wedges = (h: Harness) => h.store.listEpicStackWedges(REPO, PARENT);

  test("a re-spawned middle child orphans its layer: unstack, drop the rows, record the wedge", async () => {
    const h = makeHarness({ withPr: [LOWER, MIDDLE, UPPER] });
    seedStack(h, STALE_PR); // the child's live PR is PR_OF[MIDDLE], not this one

    await compose(h);

    expect(h.rec.unstacked).toEqual([STACK_NUMBER]);
    expect(layers(h)).toEqual([]); // the stack is gone; nothing may keep believing in it
    expect(wedges(h)).toEqual([
      { childNumber: MIDDLE, stackNumber: STACK_NUMBER, stranded: [UPPER] },
    ]);
    expect(h.rec.created).toEqual([]); // and the pass does NOT re-compose around the hole
  });

  test("a closed layer PR wedges too, even though the child still holds that PR", async () => {
    const h = makeHarness({ withPr: [LOWER, MIDDLE, UPPER] });
    seedStack(h, PR_OF[MIDDLE]!);
    h.prCache[h.sessionOf[MIDDLE]!] = {
      kind: "github",
      state: "closed",
      number: PR_OF[MIDDLE]!,
      checks: "success",
      deployConfigured: false,
    };

    await compose(h);

    expect(h.rec.unstacked).toEqual([STACK_NUMBER]);
    expect(wedges(h).map((w) => w.childNumber)).toEqual([MIDDLE]);
  });

  test("an unknown live PR is never evidence — a cold PR cache must not dissolve a stack", async () => {
    const h = makeHarness({ withPr: [] }); // no PR observed for any child, as after a restart
    seedStack(h, STALE_PR);

    await compose(h);

    expect(h.rec.unstacked).toEqual([]);
    expect(layers(h)).toHaveLength(3);
    expect(wedges(h)).toEqual([]);
  });

  test("a live wedge halts composition and suppresses stacked spawn bases", async () => {
    let t = 1_000_000;
    const h = makeHarness({ withPr: [LOWER, MIDDLE, UPPER], now: () => t });
    seedStack(h, STALE_PR);
    await compose(h);
    expect(wedges(h)).toHaveLength(1);

    t += 120_000; // past the pass TTL
    await compose(h);

    // No re-stacking of the surviving layers while the operator still has to act.
    expect(h.rec.created).toEqual([]);
    expect(h.rec.added).toEqual([]);
    expect(h.rec.unstacked).toEqual([STACK_NUMBER]); // and no repeat unstack call
    // Spawn bases come from buildState, INDEPENDENT of this pass — suppressing them here is what
    // makes a wedged epic fall back to waiting for merges instead of spawning onto dead branches.
    const { state } = await (
      h.drain as unknown as {
        buildState: (repoPath: string) => Promise<{ state: { epicStackBases: unknown } }>;
      }
    ).buildState(REPO);
    expect(state.epicStackBases).toBeNull();
  });

  test("the wedge clears once every stranded child is off the dead branch", async () => {
    let t = 1_000_000;
    const h = makeHarness({ withPr: [LOWER, MIDDLE, UPPER], now: () => t });
    seedStack(h, STALE_PR);
    await compose(h);
    expect(wedges(h)).toHaveLength(1);

    // The operator abandons the stranded child; it will re-spawn onto the pinned branch.
    h.store.archive(h.sessionOf[UPPER]!);
    t += 120_000;
    await compose(h);

    expect(wedges(h)).toEqual([]);
  });

  test("the lost child's own state does not clear the wedge", async () => {
    // The loss here IS the middle child going away; if the sweep keyed on it, the marker would
    // clear on the next pass — after the rows the detector needs to re-raise it are already gone.
    let t = 1_000_000;
    const h = makeHarness({ withPr: [LOWER, MIDDLE, UPPER], now: () => t });
    seedStack(h, STALE_PR);
    await compose(h);

    h.store.recordEpicIntegrated(
      REPO,
      PARENT,
      MIDDLE,
      { number: PR_OF[MIDDLE]!, url: "" },
      EPIC_BRANCH,
    );
    t += 120_000;
    await compose(h);

    expect(wedges(h)).toHaveLength(1);
  });
});
