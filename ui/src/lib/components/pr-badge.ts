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
