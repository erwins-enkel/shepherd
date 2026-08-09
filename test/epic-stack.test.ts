import { test, expect, describe } from "bun:test";
import {
  buildStackSpawnPlan,
  epicChildBaseOk,
  hasLiveStackedSuccessor,
  isStackedBase,
  liveChainSegment,
  planStackComposition,
  stackRootedAtEpic,
  type EpicStackMember,
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
