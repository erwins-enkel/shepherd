import { isConflicting } from "$lib/pr-conflict";
import { checksCleared } from "$lib/checks-cleared";
import type { GitState } from "$lib/types";

/** The single reason an open PR is NOT merge-ready, or null when nothing blocks it.
 *  First-match in declaration order; see the per-branch notes below for why that order. */
export type PrReadinessBlock = "draft" | "conflict" | "behind" | "blocked" | null;

/** Why an open PR cannot be merged as it stands — the one readiness predicate shared by the
 *  merge ACTION gate (`prMergeAvailable`) and every readiness DISPLAY surface (the viewport git
 *  rail hue, the pipeline stepper, the PR badge marker). Before #1551 those disagreed: the action
 *  gate honoured `mergeStateStatus` while the display predicates read `checks` + `latestReview`
 *  alone, so a PR GitHub reports as out-of-date still lit the green "ready to merge" hue.
 *
 *  Order is load-bearing:
 *    • `draft` first — GitHub reports `mergeStateStatus: "draft"` for a draft PR, which MASKS
 *      `behind`. A draft is its own (non-amber) state, so it must win before staleness is read.
 *    • `conflict` before `behind`/`blocked` — it delegates to {@link isConflicting}, which reads
 *      the earlier, definite `dirty` signal plus the draft-guarded `mergeable === false`, and is
 *      the more actionable root cause.
 *
 *  Returns null when the host supplies no usable `mergeStateStatus` (Gitea, LocalForge, or
 *  GitHub's transient `unknown`) and nothing conflicts: staleness is simply unknowable there.
 *  The Gitea fallback stays where it has always been — in `prMergeAvailable`'s `checks` term.
 *  Non-open PRs never block (there is nothing to merge). */
export function prReadinessBlock(git: GitState | undefined): PrReadinessBlock {
  if (!git || git.state !== "open") return null;
  if (git.isDraft === true) return "draft";
  if (isConflicting(git)) return "conflict";
  if (git.mergeStateStatus === "behind") return "behind";
  if (git.mergeStateStatus === "blocked") return "blocked";
  return null;
}

/** The viewport git-disclosure toggle's rolled-up hue.
 *
 *  - `attention` (amber) — needs you: CI failed, the configured reviewer requested changes, or the
 *    PR carries a readiness block the operator can act on (see {@link amberBlock}). Staleness is
 *    amber regardless of whether Autopilot or the merge train is about to rebase it — the hue
 *    stays one pure rule with no cross-store reads.
 *  - `clear` (green) — CI green, no requested changes, and genuinely merge-ready.
 *  - `neutral` — everything else, INCLUDING a green draft: `herd-partition.ts` treats a green idle
 *    draft as parked ("rendered in slate, never the green Your turn state"), so a draft drops out
 *    of green without claiming the operator's attention. A `blocked` PR is neutral too — it loses
 *    green but never turns amber (see {@link amberBlock}).
 *
 *  Lifted out of Viewport.svelte so the whole matrix is unit-testable without mounting a
 *  3.6k-line component. `reviewing` is passed in (the caller wires it to the reviews store) to
 *  keep this pure. */
export function prRailHue(input: {
  /** Nullable as well as optional: Viewport's git store yields `GitState | null`. */
  git: GitState | null | undefined;
  reviewing: boolean;
}): "clear" | "attention" | "neutral" {
  const { git, reviewing } = input;
  if (git?.state !== "open") return "neutral";
  const block = prReadinessBlock(git);
  const changesRequested = git.latestReview?.state === "changes_requested";
  if (!reviewing && (git.checks === "failure" || changesRequested || amberBlock(block, git)))
    return "attention";
  if (git.checks === "success" && !changesRequested && block === null) return "clear";
  return "neutral";
}

/** Which readiness blocks actually mean "needs you" — deliberately NARROWER than the set that
 *  costs a PR its green, because amber is a claim on the operator's attention and every block
 *  that de-greens is not one they can act on:
 *
 *    • `conflict` — always amber, and NOT gated on CI below: a conflicting PR's CI can never go
 *      green (GitHub cannot build the merge ref), so waiting for a settled run would mean it is
 *      never flagged at all. Same reasoning as autopilot.ts's isDefiniteConflict waiver.
 *    • `behind`   — amber only once CI has CLEARED (`checksCleared`, the same gate
 *      herd-partition.ts's branchProtectionBlocked stage sits behind). While checks are still in
 *      flight the operator has nothing to do but wait, and turning the toggle amber mid-run would
 *      flag a PR that was neutral before #1551.
 *    • `blocked`  — NEVER amber. In a repo whose branch protection requires an approving review,
 *      every open PR reports BLOCKED until it is approved, so amber here would light the whole
 *      repo. It still costs the PR its green (prReadinessBlock keeps it), which is the honest
 *      part of the signal; the actionable detail lives on GitRail's merge-blocked reason line.
 *    • `draft`    — never amber: parked awaiting sign-off, not stalled. */
function amberBlock(block: PrReadinessBlock, git: GitState): boolean {
  if (block === "conflict") return true;
  if (block === "behind") return checksCleared(git.checks, git.noCi);
  return false;
}

/** Whether the PR badge shows a stale/conflict marker, and which.
 *  Scoped to the two blocks a rebase fixes: `blocked` (branch protection) already has its own
 *  Herd group and GitRail merge-blocked reason line, and would otherwise chip every PR in a
 *  protected repo; `draft` has its own slate marker. */
export function prBadgeStaleMarker(git: GitState | undefined): "behind" | "conflict" | null {
  const block = prReadinessBlock(git);
  return block === "behind" || block === "conflict" ? block : null;
}
