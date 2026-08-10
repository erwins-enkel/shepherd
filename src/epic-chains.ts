import type { EpicChild } from "./epic-core";

/** A chain decomposition of an epic's `blockedBy` DAG (#2066, epic #2063): a cover of the
 *  children by disjoint linear chains, which is the shape a GitHub stack can take.
 *
 *  A chain covers **nodes, not edges**. With `C.blockedBy = [A, B]`, `C` can sit on top of at
 *  most one of `A`/`B`; the other edge is *cross-chain* and keeps today's
 *  `blockedBy.every(b => done.has(b))` gate in `selectEpicCandidates`, which stays
 *  authoritative. Within-chain edges are the ones a later step converts into base pointers. */
export interface EpicChainDecomposition {
  /** Chains bottom→top (a chain's first entry is its root — the child that bases on the epic
   *  integration branch). Disjoint; every child appears in exactly one. Ordered by the
   *  canonical position of each chain's root. */
  chains: number[][];
  /** child # → its chain predecessor #. Absent ⇒ the child is a chain root. */
  predecessorOf: Map<number, number>;
}

/** Children in canonical order: `order`, then `number` — the SAME tie-break
 *  `selectEpicCandidates` uses. Every decision below keys on this position and nothing else
 *  (never `Map`/`Set` iteration order, never merge state), which is what makes the cut
 *  reproducible across drain ticks, restarts and input reordering. */
function canonicalOrder(children: EpicChild[]): EpicChild[] {
  return [...children].sort((a, b) => a.order - b.order || a.number - b.number);
}

/** Would `blocker → child` close a cycle? Chain links form a forest of disjoint simple paths,
 *  so it does exactly when `child` already sits below `blocker` in its chain. `assembleEpic`
 *  filters self-loops and out-of-epic edges but does NOT reject cycles, so a cyclic `blockedBy`
 *  reaches here — and a cyclic chain would be a base pointing at itself transitively. */
function closesCycle(predecessorOf: Map<number, number>, blocker: number, child: number): boolean {
  let n: number | undefined = blocker;
  while (n !== undefined) {
    if (n === child) return true;
    n = predecessorOf.get(n);
  }
  return false;
}

/** The chain predecessor to give `child`, or undefined when it starts a new chain.
 *
 *  Candidates are its blockers, deduped (the markdown path in `epic-model.ts` appends edges
 *  without deduping), restricted to epic members, and not already spoken for — a node has at
 *  most one successor, which is what keeps chains linear under fan-out.
 *
 *  Of those, the HIGHEST canonical blocker wins. A fan-in child is only ever spawnable early
 *  while exactly one blocker is outstanding, and the latest-authored blocker is the one most
 *  likely to still be in flight at that moment, so this absorbs strictly more edges than
 *  picking the earliest. Both choices are equally deterministic. */
function pickPredecessor(
  child: EpicChild,
  position: Map<number, number>,
  taken: Set<number>,
  predecessorOf: Map<number, number>,
): number | undefined {
  const blockers = [...new Set(child.blockedBy)]
    .filter((b) => b !== child.number && position.has(b) && !taken.has(b))
    .sort((a, b) => position.get(b)! - position.get(a)!); // highest canonical first
  for (const b of blockers) {
    if (!closesCycle(predecessorOf, b, child.number)) return b;
  }
  return undefined;
}

/** Read the chains back out of the link map: every child with no predecessor is a chain root,
 *  followed bottom→top through the inverted map. */
function readChains(canonical: EpicChild[], predecessorOf: Map<number, number>): number[][] {
  const successorOf = new Map<number, number>();
  for (const [child, pred] of predecessorOf) successorOf.set(pred, child);
  const chains: number[][] = [];
  for (const c of canonical) {
    if (predecessorOf.has(c.number)) continue;
    const chain: number[] = [];
    for (let n: number | undefined = c.number; n !== undefined; n = successorOf.get(n)) {
      chain.push(n);
    }
    chains.push(chain);
  }
  return chains;
}

/** Greedy path cover of the epic's `blockedBy` DAG — see {@link EpicChainDecomposition}.
 *  Pure and deterministic: the same children always yield the same cut, and the result is
 *  independent of the input array's order (only each child's `order`/`number` matters).
 *
 *  Deliberately blind to merge state. If done-ness fed the choice of predecessor, a blocker
 *  merging mid-run could re-point a LIVE child's base — the cut is recomputed every drain tick.
 *  Done-ness is applied afterwards by {@link stackPredecessorOf}, which only ever removes a
 *  stack, never moves one. Children are assumed number-unique (`assembleEpic` guarantees it). */
export function decomposeEpicChains(children: EpicChild[]): EpicChainDecomposition {
  const canonical = canonicalOrder(children);
  const position = new Map(canonical.map((c, i) => [c.number, i]));
  const predecessorOf = new Map<number, number>();
  const taken = new Set<number>();
  for (const c of canonical) {
    const pred = pickPredecessor(c, position, taken, predecessorOf);
    if (pred === undefined) continue;
    predecessorOf.set(c.number, pred);
    taken.add(pred);
  }
  return { chains: readChains(canonical, predecessorOf), predecessorOf };
}

/** The predecessor `childNumber` should actually stack on, or null when it should not be
 *  stacked at all — i.e. it is a chain root, or its chain predecessor is already done-in-epic
 *  (`integrationMerged || issueClosed`). A child whose predecessor is done bases on the epic
 *  integration branch and takes today's path; there is nothing left in flight to stack onto. */
export function stackPredecessorOf(
  children: EpicChild[],
  decomposition: EpicChainDecomposition,
  childNumber: number,
): number | null {
  const pred = decomposition.predecessorOf.get(childNumber);
  if (pred === undefined) return null;
  // Fails safe (not stacked) if the decomposition was built from a different child set.
  const p = children.find((c) => c.number === pred);
  return !p || p.integrationMerged || p.issueClosed ? null : pred;
}
