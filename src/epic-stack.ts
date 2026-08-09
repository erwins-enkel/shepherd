/** Pure derivations for stacked epic children (#2069, epic #2063).
 *
 *  A stacked child is spawned on its chain predecessor's PR head branch instead of waiting for
 *  that predecessor to merge, and the resulting PRs are linked into a GitHub stack rooted at the
 *  epic's pinned integration branch. Everything the drain DECIDES about that lives here; the drain
 *  only reads the forge/store and applies the result.
 *
 *  Chains come from {@link decomposeEpicChains} (#2066) and the stack API from #2068. */
import { isEpicIntegrationBranch } from "./epic-branch";
import type { EpicChainDecomposition } from "./epic-chains";
import { stackPredecessorOf } from "./epic-chains";
import type { EpicChild } from "./epic-core";
import type { StackInfo } from "./forge/types";

/** Does this stack land on the epic's integration branch? THE definition of "rooted at the epic",
 *  shared by the retire base gate and the composition planner so the two can never disagree.
 *
 *  Reads the stack's TRUNK, never a PR's direct base: the moment a lower layer merges, GitHub
 *  auto-restacks the remainder and re-targets the next PR to the trunk, so a direct-base test
 *  would start failing on every stacked child exactly when its predecessor lands. */
export function stackRootedAtEpic(stack: StackInfo | null, pinnedBranch: string | null): boolean {
  return !!stack && !!pinnedBranch && stack.baseRef === pinnedBranch;
}

/** Is this session's spawn base a STACKED base — a sibling's head branch rather than the epic's
 *  integration branch?
 *
 *  Keyed on the branch SHAPE, not on the `epicStacksEnabled` flag, deliberately: a session spawned
 *  while the flag was on must keep being judged as stacked if the flag is later turned off, or the
 *  unsafe equality below would come back for exactly the children it is unsafe for. The
 *  epic-branch test keeps a child of a SUPERSEDED epic (base `epic/<other>-<slug>`, so not the
 *  currently pinned branch) on the old equality rule, which is what it has always had. */
export function isStackedBase(sessionBase: string, pinnedBranch: string | null): boolean {
  return sessionBase !== pinnedBranch && !isEpicIntegrationBranch(sessionBase);
}

export interface EpicChildBaseInput {
  /** The PR's live base ref (`prReviewMeta().baseRefName`). */
  actualBase: string;
  /** The base the session was spawned on (`Session.baseBranch`). */
  sessionBase: string;
  /** The stack the PR belongs to, or null when it belongs to none / could not be read. */
  stack: StackInfo | null;
  /** The epic's pinned integration branch, or null when unpinned. */
  pinnedBranch: string | null;
}

/** May this epic child's PR be merged at retire? The ONE base rule; `epicChildBaseBlocked` derives
 *  nothing of its own.
 *
 *  - A stack member rooted at the pinned branch is accepted whatever its direct base says — this is
 *    the auto-restack case, where GitHub has re-targeted the PR to the trunk while the session
 *    still records the predecessor's branch.
 *  - A session on a STACKED base is accepted ONLY that way. Plain equality is NOT enough: an
 *    uncomposed stacked child has `actualBase === sessionBase === <sibling's branch>`, and
 *    accepting it would squash-merge the child into its SIBLING'S branch and record it integrated
 *    there. Fail closed instead; the existing `epic_base_mismatch` marker surfaces the remedy.
 *  - Otherwise (the session bases on the epic branch) the historical rule applies unchanged. */
export function epicChildBaseOk(i: EpicChildBaseInput): boolean {
  if (stackRootedAtEpic(i.stack, i.pinnedBranch)) return true;
  if (isStackedBase(i.sessionBase, i.pinnedBranch)) return false;
  return i.actualBase === i.sessionBase;
}

/** What the drain knows about a potential stack predecessor: the head branch a successor would be
 *  based on, and whether its PR is actually open (the earliest point at which that branch is
 *  definitely pushed and the head ref is authoritative). */
export interface StackPredecessorFact {
  headBranch: string | null;
  prOpen: boolean;
}

export interface StackSpawnPlan {
  /** Predecessor #s judged stack-ready — fed to `selectEpicCandidates` as `EpicStackContext.stackReady`. */
  stackReady: Set<number>;
  /** child # → the branch its spawn should base on (its predecessor's head). */
  baseByChild: Map<number, string>;
}

/** Which children may spawn onto a predecessor's branch, and onto which branch.
 *
 *  A predecessor qualifies only when {@link stackPredecessorOf} names it (so it is neither a chain
 *  root's absent predecessor nor an already-done one) AND its PR is open with a resolvable head
 *  branch. Anything else simply yields no entry, leaving the child on today's wait-for-merge path. */
export function buildStackSpawnPlan(input: {
  children: EpicChild[];
  decomposition: EpicChainDecomposition;
  facts: Map<number, StackPredecessorFact>;
}): StackSpawnPlan {
  const stackReady = new Set<number>();
  const baseByChild = new Map<number, string>();
  for (const c of input.children) {
    const pred = stackPredecessorOf(input.children, input.decomposition, c.number);
    if (pred === null) continue;
    const f = input.facts.get(pred);
    if (!f?.prOpen || !f.headBranch) continue;
    stackReady.add(pred);
    baseByChild.set(c.number, f.headBranch);
  }
  return { stackReady, baseByChild };
}

/** Is a child stacked on `childNumber` already spawned and still in flight?
 *
 *  Drives the `deleteBranch` suppression at the predecessor's retire: deleting a merged layer's
 *  head would pull the base out from under a successor that has not opened its PR yet, and
 *  `gh pr create --base <deleted branch>` then fails outright. Reads `predecessorOf` directly
 *  rather than {@link stackPredecessorOf}: at retire the predecessor is not yet integrated, so the
 *  done-ness filter would be a no-op, and the raw edge is the one that describes the base pointer.
 *
 *  Over-reporting is harmless (a branch lingers); under-reporting orphans a live child. */
export function hasLiveStackedSuccessor(input: {
  children: EpicChild[];
  decomposition: EpicChainDecomposition;
  childNumber: number;
}): boolean {
  return input.children.some(
    (c) =>
      input.decomposition.predecessorOf.get(c.number) === input.childNumber &&
      !c.integrationMerged &&
      !c.issueClosed &&
      (c.sessionId != null || c.claimed),
  );
}

/** One persisted `epic_stack` row, as the planner reads it. */
export interface EpicStackMember {
  childNumber: number;
  stackNumber: number;
  prNumber: number;
  position: number;
}

/** One layer of a planned composition step. */
export interface StackLayer {
  childNumber: number;
  prNumber: number;
}

export type StackComposition =
  | { kind: "none" }
  // A stack needs two layers to exist at all, so `create` names both rather than shipping an
  // array the caller has to re-assert the length of.
  | { kind: "create"; bottom: StackLayer; next: StackLayer }
  | ({ kind: "add"; stackNumber: number; position: number } & StackLayer);

/** The CONTIGUOUS run of still-in-flight children in a chain, starting at its lowest live layer.
 *
 *  Merely filtering the done children out would splice a chain back together across a hole — with
 *  the middle child merged, `[bottom, top]` would plan a stack whose top layer is not actually
 *  based on its bottom one, and GitHub would reject (or worse, accept) it. Cutting at the first
 *  done child above the segment keeps every planned layer genuinely adjacent. */
export function liveChainSegment(
  chain: number[],
  isLive: (childNumber: number) => boolean,
): number[] {
  const start = chain.findIndex(isLive);
  if (start < 0) return [];
  const segment: number[] = [];
  for (const n of chain.slice(start)) {
    if (!isLive(n)) break;
    segment.push(n);
  }
  return segment;
}

/** The single composition step to take for one chain, or `none`.
 *
 *  `chain` is bottom→top and must already be narrowed with {@link liveChainSegment}. Only the
 *  contiguous prefix whose children all have an open PR can be stacked — a stack is linear and
 *  rooted at its bottom layer's base, so a gap cannot be bridged.
 *
 *  Deliberately returns at most ONE mutation: the pass runs every tick, each step is durable, and
 *  bounding it keeps a wide epic from firing a burst of writes at the host. An inconsistent row
 *  set (rows above an unrecorded layer) yields `none` rather than a guess — GitHub has no reorder
 *  or insert API, so repair is unstack-and-recreate and belongs to a deliberate repair path. */
export function planStackComposition(input: {
  chain: number[];
  prByChild: Map<number, number>;
  existing: Map<number, EpicStackMember>;
}): StackComposition {
  const layers: StackLayer[] = [];
  for (const childNumber of input.chain) {
    const prNumber = input.prByChild.get(childNumber);
    if (prNumber == null) break;
    layers.push({ childNumber, prNumber });
  }
  if (layers.length < 2) return { kind: "none" };
  const rows = layers.map((l) => input.existing.get(l.childNumber) ?? null);
  const firstGap = rows.findIndex((r) => r === null);
  if (firstGap < 0) return { kind: "none" }; // fully composed
  if (rows.slice(firstGap).some((r) => r !== null)) return { kind: "none" }; // rows above a gap
  if (firstGap === 0) return { kind: "create", bottom: layers[0]!, next: layers[1]! };
  const below = rows[firstGap - 1]!;
  const layer = layers[firstGap]!;
  return {
    kind: "add",
    stackNumber: below.stackNumber,
    childNumber: layer.childNumber,
    prNumber: layer.prNumber,
    position: below.position + 1,
  };
}
