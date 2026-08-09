import { test, expect, describe } from "bun:test";
import {
  bottomMostUnmergedPr,
  buildStackSpawnPlan,
  detectStackWedge,
  epicChildBaseOk,
  hasLiveStackedSuccessor,
  isStackedBase,
  liveChainSegment,
  planStackComposition,
  stackRetireGate,
  stackRootedAtEpic,
  wedgeCleared,
  type EpicStackMember,
  type StrandedChildFact,
  type WedgeChildFact,
} from "../src/epic-stack";
import { decomposeEpicChains } from "../src/epic-chains";
import type { EpicChild } from "../src/epic-core";
import type { StackInfo } from "../src/forge/types";

// #2069 (epic #2063): the pure derivations behind stacked epic children — the base rule the retire
// gate reads, the spawn plan, the live-successor test that suppresses deleteBranch, and the
// composition planner.

const EPIC = "epic/2063-stack-epic-children";
const PRED_BRANCH = "shepherd/child-a";

function kid(
  number: number,
  order: number,
  blockedBy: number[] = [],
  over: Partial<EpicChild> = {},
): EpicChild {
  return {
    number,
    title: `#${number}`,
    url: "",
    order,
    body: "",
    blockedBy,
    state: "blocked",
    sessionId: null,
    prNumber: null,
    issueClosed: false,
    integrationMerged: false,
    claimed: false,
    ...over,
  };
}

function stack(baseRef: string, prNumbers = [10, 11]): StackInfo {
  return { number: 7, baseRef, prNumbers };
}

describe("stackRootedAtEpic", () => {
  test("true only when the stack's trunk is the pinned branch", () => {
    expect(stackRootedAtEpic(stack(EPIC), EPIC)).toBe(true);
    expect(stackRootedAtEpic(stack("main"), EPIC)).toBe(false);
  });

  test("null stack or unpinned epic is never rooted", () => {
    expect(stackRootedAtEpic(null, EPIC)).toBe(false);
    expect(stackRootedAtEpic(stack(EPIC), null)).toBe(false);
  });
});

describe("isStackedBase", () => {
  test("a sibling's head branch is a stacked base", () => {
    expect(isStackedBase(PRED_BRANCH, EPIC)).toBe(true);
  });

  test("the pinned branch is not", () => {
    expect(isStackedBase(EPIC, EPIC)).toBe(false);
  });

  test("a SUPERSEDED epic's branch is not — those children keep the old equality rule", () => {
    expect(isStackedBase("epic/999-older-epic", EPIC)).toBe(false);
  });
});

describe("epicChildBaseOk", () => {
  test("unstacked child on the epic branch: today's equality rule", () => {
    const base = { sessionBase: EPIC, stack: null, pinnedBranch: EPIC };
    expect(epicChildBaseOk({ ...base, actualBase: EPIC })).toBe(true);
    expect(epicChildBaseOk({ ...base, actualBase: "main" })).toBe(false);
  });

  test("auto-restacked child: direct base moved to the trunk, accepted via the stack", () => {
    // Predecessor merged → GitHub re-targeted the PR to the trunk while the session still
    // records the predecessor's branch. This is the case the whole issue exists for.
    expect(
      epicChildBaseOk({
        actualBase: EPIC,
        sessionBase: PRED_BRANCH,
        stack: stack(EPIC),
        pinnedBranch: EPIC,
      }),
    ).toBe(true);
  });

  test("composed stacked child still targeting its predecessor is accepted via the trunk", () => {
    expect(
      epicChildBaseOk({
        actualBase: PRED_BRANCH,
        sessionBase: PRED_BRANCH,
        stack: stack(EPIC),
        pinnedBranch: EPIC,
      }),
    ).toBe(true);
  });

  test("UNCOMPOSED stacked child fails closed even though its bases match", () => {
    // Accepting this would squash-merge the child into its SIBLING'S branch.
    expect(
      epicChildBaseOk({
        actualBase: PRED_BRANCH,
        sessionBase: PRED_BRANCH,
        stack: null,
        pinnedBranch: EPIC,
      }),
    ).toBe(false);
  });

  test("a stack rooted somewhere other than the epic branch is not an accept", () => {
    expect(
      epicChildBaseOk({
        actualBase: PRED_BRANCH,
        sessionBase: PRED_BRANCH,
        stack: stack("main"),
        pinnedBranch: EPIC,
      }),
    ).toBe(false);
  });
});

describe("buildStackSpawnPlan", () => {
  const chainKids = () => [kid(320, 0), kid(321, 1, [320]), kid(322, 2, [321])];

  test("predecessor with an open PR makes its successor stack-eligible", () => {
    const children = chainKids();
    const plan = buildStackSpawnPlan({
      children,
      decomposition: decomposeEpicChains(children),
      facts: new Map([[320, { headBranch: PRED_BRANCH, prOpen: true }]]),
    });
    expect([...plan.stackReady]).toEqual([320]);
    expect([...plan.baseByChild]).toEqual([[321, PRED_BRANCH]]);
  });

  test("no PR / no branch ⇒ no entry (child stays on the wait-for-merge path)", () => {
    const children = chainKids();
    const d = decomposeEpicChains(children);
    const noPr = buildStackSpawnPlan({
      children,
      decomposition: d,
      facts: new Map([[320, { headBranch: PRED_BRANCH, prOpen: false }]]),
    });
    expect(noPr.baseByChild.size).toBe(0);
    const noBranch = buildStackSpawnPlan({
      children,
      decomposition: d,
      facts: new Map([[320, { headBranch: null, prOpen: true }]]),
    });
    expect(noBranch.baseByChild.size).toBe(0);
  });

  test("a done predecessor is not stacked onto — the successor bases on the epic branch", () => {
    const children = [kid(320, 0, [], { integrationMerged: true }), kid(321, 1, [320])];
    const plan = buildStackSpawnPlan({
      children,
      decomposition: decomposeEpicChains(children),
      facts: new Map([[320, { headBranch: PRED_BRANCH, prOpen: true }]]),
    });
    expect(plan.baseByChild.size).toBe(0);
  });

  test("chain roots are never stacked", () => {
    const children = [kid(320, 0), kid(321, 1)];
    const plan = buildStackSpawnPlan({
      children,
      decomposition: decomposeEpicChains(children),
      facts: new Map([[320, { headBranch: PRED_BRANCH, prOpen: true }]]),
    });
    expect(plan.baseByChild.size).toBe(0);
  });
});

describe("hasLiveStackedSuccessor", () => {
  const ask = (children: EpicChild[], childNumber: number) =>
    hasLiveStackedSuccessor({
      children,
      decomposition: decomposeEpicChains(children),
      childNumber,
    });

  test("spawned, PR-less successor counts — its base branch must survive the merge", () => {
    expect(ask([kid(320, 0), kid(321, 1, [320], { sessionId: "s1" })], 320)).toBe(true);
  });

  test("a claimed-but-session-less successor (spawned then retired) counts", () => {
    expect(ask([kid(320, 0), kid(321, 1, [320], { claimed: true })], 320)).toBe(true);
  });

  test("an unspawned successor does not — nothing is based on the branch yet", () => {
    expect(ask([kid(320, 0), kid(321, 1, [320])], 320)).toBe(false);
  });

  test("a done successor does not", () => {
    expect(
      ask([kid(320, 0), kid(321, 1, [320], { sessionId: "s1", integrationMerged: true })], 320),
    ).toBe(false);
    expect(
      ask([kid(320, 0), kid(321, 1, [320], { sessionId: "s1", issueClosed: true })], 320),
    ).toBe(false);
  });

  test("a cross-chain dependent is not a stacked successor", () => {
    // 322 blocks on both; the cut gives it ONE predecessor, so the other edge stays a wait.
    const children = [kid(320, 0), kid(321, 1), kid(322, 2, [320, 321], { sessionId: "s1" })];
    const d = decomposeEpicChains(children);
    const pred = d.predecessorOf.get(322)!;
    const other = pred === 320 ? 321 : 320;
    expect(hasLiveStackedSuccessor({ children, decomposition: d, childNumber: other })).toBe(false);
  });
});

describe("liveChainSegment", () => {
  const seg = (chain: number[], done: number[]) =>
    liveChainSegment(chain, (n) => !done.includes(n));

  test("all live ⇒ the whole chain", () => {
    expect(seg([320, 321, 322], [])).toEqual([320, 321, 322]);
  });

  test("done bottom layers are dropped — the next live child is the new root", () => {
    expect(seg([320, 321, 322], [320])).toEqual([321, 322]);
  });

  test("a done MIDDLE layer cuts the segment rather than splicing across it", () => {
    // [320, 322] would plan a stack whose top layer is not based on its bottom one.
    expect(seg([320, 321, 322], [321])).toEqual([320]);
  });

  test("nothing live ⇒ empty", () => {
    expect(seg([320, 321], [320, 321])).toEqual([]);
  });
});

describe("planStackComposition", () => {
  const row = (
    childNumber: number,
    prNumber: number,
    position: number,
    stackNumber = 7,
  ): EpicStackMember => ({ childNumber, prNumber, position, stackNumber });

  test("seeds the stack from the bottom pair", () => {
    expect(
      planStackComposition({
        chain: [320, 321, 322],
        prByChild: new Map([
          [320, 10],
          [321, 11],
        ]),
        existing: new Map(),
      }),
    ).toEqual({
      kind: "create",
      bottom: { childNumber: 320, prNumber: 10 },
      next: { childNumber: 321, prNumber: 11 },
    });
  });

  test("extends an existing stack by exactly one layer", () => {
    expect(
      planStackComposition({
        chain: [320, 321, 322],
        prByChild: new Map([
          [320, 10],
          [321, 11],
          [322, 12],
        ]),
        existing: new Map([
          [320, row(320, 10, 1)],
          [321, row(321, 11, 2)],
        ]),
      }),
    ).toEqual({ kind: "add", stackNumber: 7, childNumber: 322, prNumber: 12, position: 3 });
  });

  test("fewer than two PRs, or a fully composed chain, is a no-op", () => {
    expect(
      planStackComposition({
        chain: [320, 321],
        prByChild: new Map([[320, 10]]),
        existing: new Map(),
      }),
    ).toEqual({ kind: "none" });
    expect(
      planStackComposition({
        chain: [320, 321],
        prByChild: new Map([
          [320, 10],
          [321, 11],
        ]),
        existing: new Map([
          [320, row(320, 10, 1)],
          [321, row(321, 11, 2)],
        ]),
      }),
    ).toEqual({ kind: "none" });
  });

  test("a PR gap stops the prefix — the layer above it is not stacked over a hole", () => {
    expect(
      planStackComposition({
        chain: [320, 321, 322],
        prByChild: new Map([
          [320, 10],
          [322, 12],
        ]),
        existing: new Map(),
      }),
    ).toEqual({ kind: "none" });
  });

  test("rows above an unrecorded layer are left alone rather than guessed at", () => {
    expect(
      planStackComposition({
        chain: [320, 321],
        prByChild: new Map([
          [320, 10],
          [321, 11],
        ]),
        existing: new Map([[321, row(321, 11, 2)]]),
      }),
    ).toEqual({ kind: "none" });
  });
});

// ── #2070: bottom-up retire + mid-stack loss ────────────────────────────────

const layer = (
  childNumber: number,
  prNumber: number,
  position: number,
  stackNumber = 7,
): EpicStackMember => ({ childNumber, prNumber, position, stackNumber });

describe("stackRetireGate", () => {
  const rows = [layer(320, 10, 1), layer(321, 11, 2), layer(322, 12, 3)];

  test("a child with no recorded layer merges the old way", () => {
    expect(stackRetireGate({ rows, childNumber: 999, integratedChildren: new Set() })).toEqual({
      kind: "plain",
    });
  });

  test("the bottom layer is confirmable", () => {
    expect(stackRetireGate({ rows, childNumber: 320, integratedChildren: new Set() })).toEqual({
      kind: "confirm",
      stackNumber: 7,
    });
  });

  test("a higher layer holds, naming the LOWEST unlanded layer below it", () => {
    expect(stackRetireGate({ rows, childNumber: 322, integratedChildren: new Set() })).toEqual({
      kind: "hold",
      reason: "stack_layer_below_unmerged",
      belowChild: 320,
    });
  });

  test("the next layer becomes confirmable as the ones below land", () => {
    expect(stackRetireGate({ rows, childNumber: 321, integratedChildren: new Set([320]) })).toEqual(
      {
        kind: "confirm",
        stackNumber: 7,
      },
    );
    expect(
      stackRetireGate({ rows, childNumber: 322, integratedChildren: new Set([320, 321]) }),
    ).toEqual({ kind: "confirm", stackNumber: 7 });
  });

  test("layers of a SIBLING stack never gate this one", () => {
    const twoStacks = [...rows, layer(400, 40, 1, 9), layer(401, 41, 2, 9)];
    expect(
      stackRetireGate({ rows: twoStacks, childNumber: 401, integratedChildren: new Set([400]) }),
    ).toEqual({ kind: "confirm", stackNumber: 9 });
  });
});

describe("bottomMostUnmergedPr", () => {
  test("skips the layers that already landed", () => {
    expect(bottomMostUnmergedPr([10, 11, 12], new Set([10]))).toBe(11);
  });

  test("null once the whole stack has landed", () => {
    expect(bottomMostUnmergedPr([10, 11], new Set([10, 11]))).toBeNull();
  });

  test("a stack PR belonging to no integrated child reads as unmerged (fail closed)", () => {
    expect(bottomMostUnmergedPr([99, 10, 11], new Set([10, 11]))).toBe(99);
  });
});

describe("detectStackWedge", () => {
  // 320 is the stack's bottom (spawned on the epic branch); 321/322 sit on a sibling's head.
  const rows = [layer(320, 10, 1), layer(321, 11, 2), layer(322, 12, 3)];
  const fact = (
    integrationMerged: boolean,
    prNumber: number | null,
    over: Partial<WedgeChildFact> = {},
  ): WedgeChildFact => ({
    integrationMerged,
    issueClosed: false,
    prNumber,
    spawnBase: PRED_BRANCH,
    ...over,
  });
  const healthy = new Map<number, WedgeChildFact>([
    [320, fact(false, 10, { spawnBase: EPIC })],
    [321, fact(false, 11)],
    [322, fact(false, 12)],
  ]);
  const wedge = (
    facts: Map<number, WedgeChildFact>,
    closedPrs: ReadonlySet<number> = new Set(),
    r = rows,
  ) => detectStackWedge({ rows: r, facts, closedPrs, pinnedBranch: EPIC });

  test("a healthy stack is not a wedge", () => {
    expect(wedge(healthy)).toBeNull();
  });

  test("a re-spawned middle child (new PR) wedges the stack", () => {
    const facts = new Map(healthy);
    facts.set(321, fact(false, 77)); // abandoned, re-spawned, opened a fresh PR
    // #321 itself is stranded too: its NEW session was spawned on a sibling's head as well.
    expect(wedge(facts)).toEqual({ stackNumber: 7, lostChild: 321, stranded: [321, 322] });
  });

  test("a closed layer PR wedges even while the child keeps that PR", () => {
    expect(wedge(healthy, new Set([11]))).toEqual({
      stackNumber: 7,
      lostChild: 321,
      stranded: [321, 322],
    });
  });

  // The whole stack is dissolved (GitHub has no drop-one), so a layer BELOW the hole is left just
  // as un-retirable as one above it — `epicChildBaseOk` reads the session's spawn base, which is
  // never updated. Reachable on any chain of 4+ whose hole is at position 3 or higher.
  test("layers BELOW the lost one are stranded too — unstack takes the whole stack", () => {
    const deep = [layer(320, 10, 1), layer(321, 11, 2), layer(322, 12, 3), layer(323, 13, 4)];
    const facts = new Map<number, WedgeChildFact>([
      [320, fact(false, 10, { spawnBase: EPIC })],
      [321, fact(false, 11)], // healthy, below the hole — and stranded by the dissolve
      [322, fact(false, 88)], // the hole: re-spawned onto a new PR
      [323, fact(false, 13)],
    ]);
    expect(wedge(facts, new Set(), deep)).toEqual({
      stackNumber: 7,
      lostChild: 322,
      stranded: [321, 322, 323],
    });
  });

  test("the bottom layer is never stranded — it still targets the epic branch", () => {
    const facts = new Map(healthy);
    facts.set(321, fact(false, 77));
    expect(wedge(facts)?.stranded).not.toContain(320);
  });

  test("an abandoned layer with no live session is not stranded — it re-spawns rooted", () => {
    const facts = new Map(healthy);
    facts.set(321, fact(false, 77));
    facts.set(322, fact(false, 12, { spawnBase: null }));
    expect(wedge(facts)).toEqual({ stackNumber: 7, lostChild: 321, stranded: [321] });
  });

  test("an unknown (null) live PR is never evidence — a restart must not unstack anything", () => {
    const facts = new Map<number, WedgeChildFact>([
      [320, fact(false, null, { spawnBase: EPIC })],
      [321, fact(false, null)],
      [322, fact(false, null)],
    ]);
    expect(wedge(facts)).toBeNull();
  });

  test("an integrated layer is not lost, whatever the child's live PR now says", () => {
    const facts = new Map(healthy);
    facts.set(320, fact(true, 55, { spawnBase: EPIC })); // landed, then a new session/PR
    expect(wedge(facts)).toBeNull();
  });

  // The epic model counts a closed issue as done, but a closed issue whose layer never integrated
  // means that PR will never land — and the retire gate only relaxes for an INTEGRATED layer. With
  // no wedge here, every layer above it would hold forever, silently.
  test("a closed-but-unintegrated middle child is a lost layer", () => {
    const facts = new Map(healthy);
    facts.set(321, fact(false, 11, { issueClosed: true }));
    // #321 is done in the epic's eyes, so it is not among the children needing rescue.
    expect(wedge(facts)).toEqual({ stackNumber: 7, lostChild: 321, stranded: [322] });
  });

  test("a dead TOP layer strands nobody — dissolving there would only make victims", () => {
    const facts = new Map(healthy);
    facts.set(322, fact(false, 88));
    expect(wedge(facts)).toBeNull();
  });

  test("a closed-issue layer ABOVE the hole does not trigger a wedge on its own", () => {
    const facts = new Map(healthy);
    facts.set(321, fact(false, 77));
    facts.set(322, fact(false, 12, { issueClosed: true }));
    expect(wedge(facts)).toBeNull();
  });

  test("a dead top layer in one chain does not mask a real wedge in another", () => {
    const twoStacks = [...rows, layer(400, 40, 1, 9), layer(401, 41, 2, 9)];
    const facts = new Map(healthy);
    facts.set(322, fact(false, 88)); // chain A: dead TOP layer, strands nobody
    facts.set(400, fact(false, 40, { spawnBase: EPIC }));
    facts.set(401, fact(false, 99)); // chain B: dead TOP layer too
    facts.set(321, fact(false, 77)); // chain A: the real wedge
    expect(wedge(facts, new Set(), twoStacks)).toEqual({
      stackNumber: 7,
      lostChild: 321,
      stranded: [321, 322],
    });
  });

  test("stranded skips layers that already landed", () => {
    const facts = new Map(healthy);
    facts.set(321, fact(false, 77));
    facts.set(322, fact(true, 12));
    expect(wedge(facts)).toBeNull();
  });
});

describe("wedgeCleared", () => {
  const fact = (over: Partial<StrandedChildFact> = {}): StrandedChildFact => ({
    integrationMerged: false,
    issueClosed: false,
    spawnBase: PRED_BRANCH,
    ...over,
  });

  test("stays raised while a stranded child still sits on the dead branch", () => {
    expect(
      wedgeCleared({
        stranded: [322],
        facts: new Map([[322, fact()]]),
        pinnedBranch: EPIC,
      }),
    ).toBe(false);
  });

  test("an abandoned stranded child (no live session) is resolved", () => {
    expect(
      wedgeCleared({
        stranded: [322],
        facts: new Map([[322, fact({ spawnBase: null })]]),
        pinnedBranch: EPIC,
      }),
    ).toBe(true);
  });

  test("a stranded child re-spawned onto the epic branch is resolved", () => {
    expect(
      wedgeCleared({
        stranded: [322],
        facts: new Map([[322, fact({ spawnBase: EPIC })]]),
        pinnedBranch: EPIC,
      }),
    ).toBe(true);
  });

  test("integrated or closed stranded children are resolved", () => {
    expect(
      wedgeCleared({
        stranded: [322, 323],
        facts: new Map([
          [322, fact({ integrationMerged: true })],
          [323, fact({ issueClosed: true })],
        ]),
        pinnedBranch: EPIC,
      }),
    ).toBe(true);
  });

  test("ALL stranded children must resolve, not just one", () => {
    expect(
      wedgeCleared({
        stranded: [322, 323],
        facts: new Map([
          [322, fact({ integrationMerged: true })],
          [323, fact()],
        ]),
        pinnedBranch: EPIC,
      }),
    ).toBe(false);
  });

  test("the lost child's own state is irrelevant — an issue-closure loss stays raised", () => {
    // The loss was caused by #321's issue closing; only #322 (stranded) decides the clear.
    expect(
      wedgeCleared({
        stranded: [322],
        facts: new Map([
          [321, fact({ issueClosed: true })],
          [322, fact()],
        ]),
        pinnedBranch: EPIC,
      }),
    ).toBe(false);
  });
});
