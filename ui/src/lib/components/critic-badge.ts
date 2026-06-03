import type { ReviewVerdict } from "../types";
import { m } from "$lib/paraglide/messages";

/** Max auto-address rounds before the loop gives up (mirrors the server's DEFAULT_CAP). */
export const CRITIC_ROUND_CAP = 3;

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
 * `stalled` = the loop hit its cap with findings still open → it gave up, needs a human.
 */
export function addressRoundInfo(
  v: ReviewVerdict | undefined,
  cap: number = CRITIC_ROUND_CAP,
): { round: number; cap: number; stalled: boolean } | null {
  if (!v || v.addressRound <= 0) return null;
  return { round: v.addressRound, cap, stalled: v.addressRound >= cap && v.findings.length > 0 };
}
