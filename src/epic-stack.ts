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

/** Why a stacked child may not merge yet (#2070). Named so the drain can log it and the retire
 *  gate can be asserted on it; deliberately NOT a session-level `HoldCode` — a layer waiting for the
 *  one below it is normal, transient and correct, not an operator problem. */
export type StackHoldReason = "stack_layer_below_unmerged";

export type StackRetireGate =
  /** Not a recorded stack member: merge exactly as before, without `allowStacked`. */
  | { kind: "plain" }
  /** A layer below this one has not landed yet. `belowChild` is the lowest such child. */
  | { kind: "hold"; reason: StackHoldReason; belowChild: number }
  /** The rows say this is the bottom-most unmerged layer — confirm against the live stack. */
  | { kind: "confirm"; stackNumber: number };

/** May this epic child's stacked PR be merged now? (#2070)
 *
 *  #2061 refuses any stacked merge whose caller did not pass `allowStacked`, and `retireEpicChild`
 *  is autonomous — so without a carve-out every epic-child retire throws once children become stack
 *  members. The carve-out is bottom-most-only, which PRESERVES #2061's rationale rather than waiving
 *  it: merging a stack layer lands every layer beneath it, so merging the bottom-most unmerged layer
 *  lands exactly one PR.
 *
 *  "Landed" means INTEGRATED, deliberately narrower than the epic model's `integrationMerged ||
 *  issueClosed` done-ness: a closed-but-unintegrated layer never merged, so merging the layer above
 *  it would still drag its ungated commits along. Such a layer is not this gate's problem to relax —
 *  it is a lost layer, and {@link detectStackWedge} raises it as a wedge.
 *
 *  Store-only (rows + the integrated set), so a held layer costs ZERO forge calls per tick — the
 *  drain re-derives this on every pump iteration. The `confirm` answer is deliberately not "merge":
 *  the rows describe what Shepherd composed, and a foreign PR hand-added to the stack would not
 *  appear in them, so the caller re-checks against the live stack before landing anything. */
export function stackRetireGate(input: {
  rows: EpicStackMember[];
  childNumber: number;
  integratedChildren: ReadonlySet<number>;
}): StackRetireGate {
  const mine = input.rows.find((r) => r.childNumber === input.childNumber);
  if (!mine) return { kind: "plain" };
  const below = input.rows
    .filter((r) => r.stackNumber === mine.stackNumber && r.position < mine.position)
    .sort((a, b) => a.position - b.position)
    .find((r) => !input.integratedChildren.has(r.childNumber));
  if (below) {
    return { kind: "hold", reason: "stack_layer_below_unmerged", belowChild: below.childNumber };
  }
  return { kind: "confirm", stackNumber: mine.stackNumber };
}

/** The bottom-most pull request of a live stack that has not landed yet, or null when every layer
 *  has. `prNumbers` is the host's own bottom→top membership and INCLUDES already-merged layers, so
 *  "merged" is decided by `integratedPrs` (which `merge-teardown` populates for out-of-band merges
 *  too, so an operator-merged layer does not wedge the one above it).
 *
 *  A stack PR that belongs to no integrated child reads as unmerged — fail closed, since the caller
 *  compares this against its own PR to decide whether merging lands only itself. */
export function bottomMostUnmergedPr(
  prNumbers: number[],
  integratedPrs: ReadonlySet<number>,
): number | null {
  return prNumbers.find((pr) => !integratedPrs.has(pr)) ?? null;
}

/** What the wedge detector knows about one epic child. `prNumber` is the child's LIVE pull request
 *  (`EpicChild.prNumber`, read from the in-memory PR cache), so `null` means "unknown" — after a
 *  restart it is null for every child — and is never evidence of anything. */
export interface WedgeChildFact {
  integrationMerged: boolean;
  issueClosed: boolean;
  prNumber: number | null;
}

export interface StackWedge {
  stackNumber: number;
  /** The child whose recorded layer PR is orphaned. */
  lostChild: number;
  /** Children whose layers sit above it and have not landed — bottom → top. */
  stranded: number[];
}

/** Has a stack lost a middle layer? (#2070)
 *
 *  Keyed on the recorded LAYER's pull request, never on child liveness: an abandon releases the
 *  claim and pumps immediately, so the drain re-spawns the child with a fresh session and PR long
 *  before the composition pass next runs. The child then looks perfectly healthy while the layer the
 *  stack was built on is orphaned — child-level signals cannot see this at all.
 *
 *  Loss requires POSITIVE evidence: the child's ISSUE is closed without the layer ever integrating,
 *  the layer PR was observed closed, or the child is now on a DIFFERENT pull request. An unknown
 *  (null) live PR is never loss, or the first pass after a restart would dissolve every healthy
 *  stack.
 *
 *  The issue-closed arm is load-bearing. The epic model counts a closed issue as done, but a closed
 *  issue whose layer never integrated means that layer's PR will never land — and the retire gate
 *  only ever treats an INTEGRATED layer as landed (rightly: nothing merged, so merging the layer
 *  above would still drag ungated commits). Without this arm such a child holds every layer above it
 *  forever, with no wedge, no warning and nothing to clear.
 *
 *  Reports only a wedge with something above it — a dead TOP layer strands nobody. */
export function detectStackWedge(input: {
  rows: EpicStackMember[];
  facts: Map<number, WedgeChildFact>;
  closedPrs: ReadonlySet<number>;
}): StackWedge | null {
  const ordered = [...input.rows].sort((a, b) => a.position - b.position);
  const lost = (r: EpicStackMember): boolean => {
    const f = input.facts.get(r.childNumber);
    if (!f || f.integrationMerged) return false;
    if (f.issueClosed) return true;
    return input.closedPrs.has(r.prNumber) || (f.prNumber !== null && f.prNumber !== r.prNumber);
  };
  // Every lost row is considered, not just the lowest: an epic runs one stack per chain, and a dead
  // TOP layer in one chain must not mask a genuine wedge in another.
  for (const row of ordered.filter(lost)) {
    const stranded = ordered
      .filter((r) => {
        if (r.stackNumber !== row.stackNumber || r.position <= row.position) return false;
        const f = input.facts.get(r.childNumber);
        // Done-in-epic layers above the hole need no rescuing — same resolution rule as
        // {@link wedgeCleared}, so a wedge is never raised for children it would clear immediately.
        return !f?.integrationMerged && !f?.issueClosed;
      })
      .map((r) => r.childNumber);
    if (stranded.length > 0) {
      return { stackNumber: row.stackNumber, lostChild: row.childNumber, stranded };
    }
  }
  return null;
}

/** What clearing a wedge marker looks at, per stranded child. `spawnBase` is the base its LIVE
 *  session was spawned on, or null when it has no live session. */
export interface StrandedChildFact {
  integrationMerged: boolean;
  issueClosed: boolean;
  spawnBase: string | null;
}

/** May this wedge marker be cleared? (#2070)
 *
 *  Keyed on the STRANDED children, never on the lost one. A stranded child is resolved once it is
 *  integrated, its issue is closed, or it is simply no longer sitting on the dead branch — it has no
 *  live session (abandoned; it re-spawns onto the pinned branch) or its live session bases on the
 *  epic branch again.
 *
 *  Keying on the lost child instead would clear the blocking warning while the stranded layers are
 *  still un-retirable — and when the loss was caused BY that child's issue closing, it would clear on
 *  the very next pass, after the rows the detector needs to re-raise it have already been deleted. */
export function wedgeCleared(input: {
  stranded: number[];
  facts: Map<number, StrandedChildFact>;
  pinnedBranch: string | null;
}): boolean {
  return input.stranded.every((n) => {
    const f = input.facts.get(n);
    if (!f) return true; // no longer a child of this epic
    if (f.integrationMerged || f.issueClosed) return true;
    return f.spawnBase === null || !isStackedBase(f.spawnBase, input.pinnedBranch);
  });
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
