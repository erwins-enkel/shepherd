import { test, expect, describe } from "bun:test";
import { decomposeEpicChains, stackPredecessorOf } from "../src/epic-chains";
import type { EpicChild } from "../src/epic-core";

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

/** Map contents as a sorted entry list — order-insensitive comparison of two decompositions. */
const links = (m: Map<number, number>) => [...m].sort((a, b) => a[0] - b[0]);

/** Every child in exactly one chain, and no node used as a predecessor twice (chains stay
 *  linear). Asserted on every shape below — it is the property the whole cut turns on. */
function expectCovers(children: EpicChild[], d: ReturnType<typeof decomposeEpicChains>) {
  expect([...d.chains.flat()].sort((a, b) => a - b)).toEqual(
    children.map((c) => c.number).sort((a, b) => a - b),
  );
  const preds = [...d.predecessorOf.values()];
  expect(new Set(preds).size).toBe(preds.length);
}

describe("decomposeEpicChains", () => {
  test("linear chain becomes one chain", () => {
    const kids = [kid(320, 0), kid(321, 1, [320]), kid(322, 2, [321])];
    const d = decomposeEpicChains(kids);
    expect(d.chains).toEqual([[320, 321, 322]]);
    expect(links(d.predecessorOf)).toEqual([
      [321, 320],
      [322, 321],
    ]);
    expectCovers(kids, d);
  });

  test("fan-out: only the first successor stacks, the sibling starts a new chain", () => {
    const kids = [kid(320, 0), kid(321, 1, [320]), kid(322, 2, [320])];
    const d = decomposeEpicChains(kids);
    expect(d.chains).toEqual([[320, 321], [322]]);
    expectCovers(kids, d);
  });

  test("fan-in: the child stacks on its highest-canonical blocker, the other edge stays cross-chain", () => {
    const kids = [kid(320, 0), kid(321, 1), kid(322, 2, [320, 321])];
    const d = decomposeEpicChains(kids);
    expect(d.chains).toEqual([[320], [321, 322]]);
    expect(d.predecessorOf.get(322)).toBe(321);
    expectCovers(kids, d);
  });

  test("diamond: two chains, one cross-chain edge left over", () => {
    const kids = [kid(320, 0), kid(321, 1, [320]), kid(322, 2, [320]), kid(323, 3, [321, 322])];
    const d = decomposeEpicChains(kids);
    expect(d.chains).toEqual([
      [320, 321],
      [322, 323],
    ]);
    expectCovers(kids, d);
  });

  test("zero-edge epic: every child is its own chain", () => {
    const kids = [kid(320, 0), kid(321, 1), kid(322, 2)];
    const d = decomposeEpicChains(kids);
    expect(d.chains).toEqual([[320], [321], [322]]);
    expect(d.predecessorOf.size).toBe(0);
    expectCovers(kids, d);
  });

  test("no children at all", () => {
    expect(decomposeEpicChains([])).toEqual({ chains: [], predecessorOf: new Map() });
  });

  test("a 2-cycle never produces a cyclic chain", () => {
    const kids = [kid(320, 0, [321]), kid(321, 1, [320])];
    const d = decomposeEpicChains(kids);
    expect(d.chains).toEqual([[321, 320]]);
    expect(d.predecessorOf.get(321)).toBeUndefined(); // the closing edge was refused
    expectCovers(kids, d);
  });

  test("a 3-cycle never produces a cyclic chain", () => {
    const kids = [kid(320, 0, [322]), kid(321, 1, [320]), kid(322, 2, [321])];
    const d = decomposeEpicChains(kids);
    expect(d.chains).toEqual([[322, 320, 321]]);
    expect(d.predecessorOf.get(322)).toBeUndefined();
    expectCovers(kids, d);
  });

  test("duplicate blocker entries collapse to one link", () => {
    const kids = [kid(320, 0), kid(321, 1, [320, 320])];
    const d = decomposeEpicChains(kids);
    expect(d.chains).toEqual([[320, 321]]);
    expectCovers(kids, d);
  });

  test("a blocker outside the epic is ignored", () => {
    const kids = [kid(320, 0), kid(321, 1, [999])];
    const d = decomposeEpicChains(kids);
    expect(d.chains).toEqual([[320], [321]]);
    expectCovers(kids, d);
  });

  test("a self-loop is ignored", () => {
    const kids = [kid(320, 0, [320])];
    expect(decomposeEpicChains(kids).chains).toEqual([[320]]);
  });

  test("children sharing an order tie-break by number", () => {
    const kids = [kid(30, 0), kid(12, 0), kid(40, 1, [30, 12])];
    const d = decomposeEpicChains(kids);
    // canonical: 12, 30, 40 → 40's highest-canonical blocker is 30
    expect(d.chains).toEqual([[12], [30, 40]]);
  });
});

describe("decomposeEpicChains determinism", () => {
  const kids = [
    kid(320, 0),
    kid(321, 1, [320]),
    kid(322, 2, [320]),
    kid(323, 3, [321, 322]),
    kid(324, 4, [323, 320]),
    kid(325, 5),
  ];

  test("repeated calls return the same cut", () => {
    const a = decomposeEpicChains(kids);
    const b = decomposeEpicChains(kids);
    expect(b.chains).toEqual(a.chains);
    expect(links(b.predecessorOf)).toEqual(links(a.predecessorOf));
  });

  test("input reordering that preserves `order` yields an identical cut", () => {
    const base = decomposeEpicChains(kids);
    const reversed = decomposeEpicChains([...kids].reverse());
    const rotated = decomposeEpicChains([...kids.slice(3), ...kids.slice(0, 3)]);
    for (const d of [reversed, rotated]) {
      expect(d.chains).toEqual(base.chains);
      expect(links(d.predecessorOf)).toEqual(links(base.predecessorOf));
    }
  });

  test("merge state does not move the cut — a merged blocker keeps its chain link", () => {
    const merged = kids.map((c) => (c.number === 320 ? kid(320, 0, [], { issueClosed: true }) : c));
    expect(links(decomposeEpicChains(merged).predecessorOf)).toEqual(
      links(decomposeEpicChains(kids).predecessorOf),
    );
  });
});

describe("stackPredecessorOf", () => {
  const kids = [kid(320, 0), kid(321, 1, [320])];

  test("a chain root has nothing to stack on", () => {
    expect(stackPredecessorOf(kids, decomposeEpicChains(kids), 320)).toBeNull();
  });

  test("a live chain predecessor is the stack base", () => {
    expect(stackPredecessorOf(kids, decomposeEpicChains(kids), 321)).toBe(320);
  });

  test("an integration-merged predecessor is not stacked onto", () => {
    const done = [kid(320, 0, [], { integrationMerged: true }), kid(321, 1, [320])];
    expect(stackPredecessorOf(done, decomposeEpicChains(done), 321)).toBeNull();
  });

  test("an issue-closed predecessor is not stacked onto", () => {
    const done = [kid(320, 0, [], { issueClosed: true }), kid(321, 1, [320])];
    expect(stackPredecessorOf(done, decomposeEpicChains(done), 321)).toBeNull();
  });
});
