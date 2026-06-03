import type { ReviewVerdict } from "../types";
import { m } from "$lib/paraglide/messages";

/** Badge text for a critic verdict, or null when there is none to show. */
export function criticBadgeLabel(v: ReviewVerdict | undefined): string | null {
  if (!v) return null;
  switch (v.decision) {
    case "changes_requested":
      return m.criticbadge_changes();
    case "commented":
      return m.criticbadge_commented();
    default:
      return m.criticbadge_error();
  }
}

/**
 * Auto-address streak state for the badge, or null when no streak is in progress.
 * The cap comes off the verdict (`addressCap`) — the server's live value — so the badge
 * math never drifts from a hardcoded mirror.
 * `stalled` = the loop hit its cap with findings still open → it gave up, needs a human.
 */
export function addressRoundInfo(
  v: ReviewVerdict | undefined,
): { round: number; cap: number; stalled: boolean } | null {
  if (!v || v.addressRound <= 0) return null;
  const cap = v.addressCap;
  return { round: v.addressRound, cap, stalled: v.addressRound >= cap && v.findings.length > 0 };
}
