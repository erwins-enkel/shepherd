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

export type AddressStatus = "round" | "final" | "stalled";

/**
 * Auto-address streak state for the badge, or null when no streak is in progress.
 * The cap comes off the verdict (`addressCap`) — the server's live value — so the badge
 * math never drifts from a hardcoded mirror.
 *  - "round":   below the cap, agent addressing findings, more rounds left (blue). Also
 *               covers a transient error verdict that holds the streak with no findings.
 *  - "final":   cap-th steer just delivered (`finalRoundPending`), agent addressing the
 *               last allowed round (dimmed). Escalates to "stalled" after the verdict's
 *               `finalRoundTimeoutMs` if no re-review lands (agent abandoned it).
 *  - "stalled": cap reached and that final round already failed re-review, OR the pending
 *               final round timed out → needs a human (orange).
 * `now` is the current time (ms); pass a reactive clock so the timeout escalation is live.
 */
export function addressRoundInfo(
  v: ReviewVerdict | undefined,
  now: number,
): { round: number; cap: number; status: AddressStatus } | null {
  if (!v || v.addressRound <= 0) return null;
  const cap = v.addressCap;
  const round = v.addressRound;
  // No findings while the streak is held = a transient error verdict (critic produced
  // nothing this pass; the round is preserved). Show the in-progress counter rather than
  // flicker it out or mis-escalate — final/stalled require a real verdict with outstanding
  // findings, which the next re-review restores.
  if (round < cap || v.findings.length === 0) return { round, cap, status: "round" };
  // At/over the cap with findings still open. A held round (not pending) is a confirmed stall.
  if (!v.finalRoundPending) return { round, cap, status: "stalled" };
  // Pending: `updatedAt` is the final-steer delivery time — putReview runs once per
  // review cycle, and the next putReview is the re-review that clears finalRoundPending,
  // so updatedAt stays frozen at delivery while pending. (If anything ever bumps updatedAt
  // mid-cycle, switch to an explicit finalRoundDeliveredAt field.)
  //
  // Clock-skew note: this compares the browser clock (`now`) against the server-stamped
  // `updatedAt`. The 15-min `finalRoundTimeoutMs` dwarfs realistic client/server skew, and
  // a mistimed flip only changes cosmetic badge colour (dimmed FINAL ↔ orange STALLED) for
  // a few seconds — it drives no server behaviour — so server-relative time isn't worth it.
  if (now - v.updatedAt > v.finalRoundTimeoutMs) return { round, cap, status: "stalled" };
  return { round, cap, status: "final" };
}
