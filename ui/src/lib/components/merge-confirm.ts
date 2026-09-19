import type { GitState, MergeMethod, PullRequest } from "$lib/types";

/** How long after the dialog opens its confirm button stays disabled (#2299).
 *
 *  The defect this whole flow exists for is a DOUBLE-CLICK satisfying a two-step confirmation. A
 *  modal alone does not fix that: the second click of a double-click arrives after the dialog has
 *  mounted, and would land on whatever now sits under the pointer. Long enough to swallow a
 *  double-click (and a key-repeat on a held Enter), short enough that nobody reads it as a broken
 *  button. */
export const CONFIRM_ARM_MS = 350;

/** Everything a merge confirmation states, resolved before the dialog opens. */
export interface MergeConfirmContext {
  /** Short repo name for the dialog's repository line; omitted where the entry point has none. */
  repoLabel?: string;
  number: number;
  title: string;
  /** The branch the merge really lands on; null when the host did not report it. */
  baseBranch: string | null;
  /** The method Shepherd would land it with; null when unknown. */
  mergeMethod: MergeMethod | null;
  /** Head revision the operator is confirming; null when the host did not report it. */
  headSha: string | null;
  handoff: "reviewer" | "merger" | null;
  handoffWho: string | null;
  reviewBlockBy: string | null;
}

/** The `confirm` payload echoed back to the server, which re-derives all of it and refuses on any
 *  drift. Shape mirrors the server's `MergeConfirm`. */
export interface MergeConfirmPayload {
  headSha: string | null;
  baseRefName: string | null;
  handoff: "reviewer" | "merger" | null;
  handoffWho: string | null;
  reviewBlockBy: string | null;
}

/** One PR row in the merge-train confirmation. The train itself is automation the operator
 *  switched on and is NOT gated server-side (#2299) — this exists so its dialog can still say
 *  whose PRs it is about to carry. */
export interface MergeTrainItem {
  number: number;
  title: string;
  handoff?: "reviewer" | "merger" | null;
  handoffWho?: string | null;
  reviewBlockBy?: string | null;
}

/** True when confirming means taking over someone else's responsibility — which is what turns the
 *  neutral "Merge PR" wording into the escalated one. */
export function isMergeTakeover(ctx: { handoff?: unknown; reviewBlockBy?: unknown }): boolean {
  return !!ctx.handoff || !!ctx.reviewBlockBy;
}

/** A session's live git state → confirmation context. Null when there is no PR to merge, so a
 *  caller cannot open the dialog on an empty rail.
 *
 *  An INFERRED handoff is dropped: `GitState.handoff` doubles as the herd's "waiting on" readout
 *  and is guessed from the PR's reviewers when a repo has no `.shepherd/roles.json`. Only a
 *  configured role makes a merge someone else's to take over, so presenting an inferred one as a
 *  takeover would both overstate it and disagree with the server gate. */
export function mergeConfirmFromGit(
  git: GitState | null | undefined,
  repoLabel?: string,
): MergeConfirmContext | null {
  if (!git || git.state !== "open" || !git.number) return null;
  const configured = !git.handoffInferred;
  return {
    repoLabel,
    number: git.number,
    title: git.title ?? "",
    baseBranch: git.baseRefName ?? null,
    mergeMethod: git.mergeMethod ?? null,
    headSha: git.headSha ?? null,
    handoff: (configured && git.handoff) || null,
    handoffWho: (configured && git.handoffWho) || null,
    // GitState carries the whole block; only the reviewer's login reaches the confirmation.
    reviewBlockBy: git.reviewBlock?.reviewer ?? null,
  };
}

/** A backlog PR row → confirmation context. The row's responsibility fields are server-stamped
 *  from the repo's roles file (see the PRs route), so no client-side role logic exists. */
export function mergeConfirmFromPr(pr: PullRequest, repoLabel: string): MergeConfirmContext {
  return {
    repoLabel,
    number: pr.number,
    title: pr.title,
    baseBranch: pr.baseRefName ?? pr.nonDefaultBase ?? null,
    mergeMethod: pr.mergeMethod ?? null,
    headSha: pr.headSha ?? null,
    handoff: pr.handoff ?? null,
    handoffWho: pr.handoffWho ?? null,
    reviewBlockBy: pr.reviewBlockBy ?? null,
  };
}

/** The context as the server wants it back. */
export function mergeConfirmPayload(ctx: MergeConfirmContext): MergeConfirmPayload {
  return {
    headSha: ctx.headSha,
    baseRefName: ctx.baseBranch,
    handoff: ctx.handoff,
    handoffWho: ctx.handoffWho,
    reviewBlockBy: ctx.reviewBlockBy,
  };
}

/** Fold the server's refreshed verdict (from a `merge_confirm_stale` / `merge_confirm_required`
 *  refusal) into the open dialog, so the operator re-confirms against what is true NOW rather than
 *  against what they were first shown. */
export function applyMergeGate(
  ctx: MergeConfirmContext,
  gate: {
    handoff?: "reviewer" | "merger" | null;
    handoffWho?: string | null;
    reviewBlockBy?: string | null;
  },
  pr: { headSha?: string | null; baseRefName?: string | null } = {},
): MergeConfirmContext {
  return {
    ...ctx,
    handoff: gate.handoff ?? null,
    handoffWho: gate.handoffWho ?? null,
    reviewBlockBy: gate.reviewBlockBy ?? null,
    // Adopted VERBATIM, null included: the server sends null for "I could not resolve this", and
    // re-adopting the client's own value there would re-submit the same mismatch forever.
    // `undefined` (the field absent) is the only case that keeps what the dialog showed.
    headSha: pr.headSha === undefined ? ctx.headSha : pr.headSha,
    baseBranch: pr.baseRefName === undefined ? ctx.baseBranch : pr.baseRefName,
  };
}
