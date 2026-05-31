import type { GitState } from "../types";
import { m } from "$lib/paraglide/messages";

/** Badge text for a session's PR state, or null when there is no entry to show.
 *  `none` is a real state ("NO PR"); only an absent entry renders nothing. */
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
      return m.prbadge_none();
  }
}
