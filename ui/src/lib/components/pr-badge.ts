import { isConflicting } from "$lib/pr-conflict";
import type { GitState } from "../types";
import { m } from "$lib/paraglide/messages";

/** Badge text for a session's PR state, or null when there is nothing to show.
 *  Both an absent entry and the `none` state render nothing; only open/merged/closed
 *  produce a visible badge. */
export function prBadgeLabel(git: GitState | undefined): string | null {
  if (!git) return null;
  switch (git.state) {
    case "open":
      return m.prbadge_open({ number: git.number ?? 0 });
    case "merged":
      return m.prbadge_merged();
    case "closed":
      return m.prbadge_closed();
    default:
      return null;
  }
}

/** Whether to show the slate DRAFT marker: only on open PRs with isDraft=true.
 *  Never returns true for merged/closed/none (not actionable, marker is for open drafts). */
export function prBadgeIsDraft(git: GitState | undefined): boolean {
  return git?.state === "open" && !!git.isDraft;
}

/** Whether the badge menu offers the Merge action. Mirrors GitRail's mergeBlocked
 *  gate (minus `busy`, which is component state): real-forge open PR, not a draft,
 *  no conflicts, and mergeStateStatus not blocked/behind — falling back to
 *  checks !== "failure" when the host reports no usable mergeStateStatus (Gitea).
 *  UI-side gate only; the server re-validates the merge. */
export function prMergeAvailable(git: GitState | undefined): boolean {
  if (!git || (git.kind !== "github" && git.kind !== "gitea")) return false;
  if (git.state !== "open" || !git.number) return false;
  // isConflicting, not `mergeable === false`: the mergeStateStatus branch below excludes only
  // blocked/behind, so a `dirty` PR whose mergeable is still null would otherwise be offered a
  // merge button it cannot use.
  if (git.isDraft === true || isConflicting(git)) return false;
  return git.mergeStateStatus && git.mergeStateStatus !== "unknown"
    ? git.mergeStateStatus !== "blocked" && git.mergeStateStatus !== "behind"
    : git.checks !== "failure";
}
