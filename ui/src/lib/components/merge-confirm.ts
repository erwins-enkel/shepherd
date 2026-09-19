import type { GitState, MergeMethod, MergeResponsibility, PullRequest } from "$lib/types";

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
  mergeGate?: MergeResponsibility;
}

/** True when confirming means taking over someone else's responsibility — which is what turns the
 *  neutral "Merge PR" wording into the escalated one. */
export function isMergeTakeover(ctx: { handoff?: unknown; reviewBlockBy?: unknown }): boolean {
  return !!ctx.handoff || !!ctx.reviewBlockBy;
}

/** Spread the server's stamped responsibility into the context's flat fields. Read from
 *  `mergeGate` and NEVER from `GitState.handoff`/`reviewBlock`: those are the herd's readout,
 *  which appears only on a green PR and is inferred where no roles are configured. Deriving the
 *  confirmation from them made it disagree with the gate that validates it. */
function responsibility(
  gate: MergeResponsibility | undefined,
): Pick<MergeConfirmContext, "handoff" | "handoffWho" | "reviewBlockBy"> {
  return {
    handoff: gate?.handoff ?? null,
    handoffWho: gate?.handoffWho ?? null,
    reviewBlockBy: gate?.reviewBlockBy ?? null,
  };
}

/** A session's live git state → confirmation context. Null when there is no PR to merge, so a
 *  caller cannot open the dialog on an empty rail. */
export function mergeConfirmFromGit(
  git: GitState | null | undefined,
  repoLabel?: string,
): MergeConfirmContext | null {
  if (!git || git.state !== "open" || !git.number) return null;
  return {
    repoLabel,
    number: git.number,
    title: git.title ?? "",
    baseBranch: git.baseRefName ?? null,
    mergeMethod: git.mergeMethod ?? null,
    headSha: git.headSha ?? null,
    ...responsibility(git.mergeGate),
  };
}

/** A backlog PR row → confirmation context. The row's responsibility is server-stamped by the same
 *  function the gate runs (see the PRs route), so no client-side role logic exists. */
export function mergeConfirmFromPr(pr: PullRequest, repoLabel: string): MergeConfirmContext {
  return {
    repoLabel,
    number: pr.number,
    title: pr.title,
    baseBranch: pr.baseRefName ?? pr.nonDefaultBase ?? null,
    mergeMethod: pr.mergeMethod ?? null,
    headSha: pr.headSha ?? null,
    ...responsibility(pr.mergeGate),
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

/** Whether a failure is the merge gate refusing the operator's confirmation (#2299).
 *
 *  Matches on the server's stable `code` rather than the error class, so callers that only see an
 *  opaque failure — the deferred decommission commit, which runs behind an undo toast — can tell
 *  "this confirmation is spent" from an ordinary merge failure WITHOUT reaching into the API
 *  module. A refusal must never be retried with the same payload: it is bound to a responsibility
 *  or revision the server has already rejected, so replaying it can only 409 again. */
export function isMergeConfirmRefusal(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "merge_confirm_required" || code === "merge_confirm_stale";
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
