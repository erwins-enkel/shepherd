import type { ReviewVerdict, ReviewDecision } from "../types";
import { m } from "$lib/paraglide/messages";
import { addressStallStatus } from "../review-status";

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
 * What the single critic chip should show, given the verdict and whether the critic is
 * re-reviewing right now. `reviewing` always wins over a stale verdict so the UI stops
 * screaming "CHANGES" while the fix is being re-validated.
 *  - "reviewing": critic running now. `hasFindings` = a prior verdict body is still readable,
 *                 so a consumer can keep the findings popover reachable during re-review.
 *  - "verdict":   not reviewing; show the verdict badge/label.
 *  - "none":      nothing to show.
 * When an auto-address streak is active (addressRoundInfo non-null), its compact streak label
 * REPLACES the reviewing/verdict pill in CriticBadge.svelte rather than rendering as an inline
 * suffix; the selector still returns the chip independently.
 */
export type CriticChip =
  | { kind: "reviewing"; hasFindings: boolean }
  | { kind: "verdict"; decision: ReviewDecision; label: string }
  | { kind: "none" };

export function criticChip(v: ReviewVerdict | undefined, reviewing: boolean): CriticChip {
  if (reviewing) return { kind: "reviewing", hasFindings: Boolean(v?.body) };
  const label = criticBadgeLabel(v);
  return label && v ? { kind: "verdict", decision: v.decision, label } : { kind: "none" };
}

export type AddressStatus = "round" | "final" | "stalled";

/**
 * Auto-address streak state for the badge, or null when no streak is in progress.
 * The cap comes off the verdict (`addressCap`) — the server's live value — so the badge
 * math never drifts from a hardcoded mirror.
 * The badge paints these on a severity ladder (hue climbs with the rung; the separate pulsing
 * dot — not the hue — is what reports that the critic is re-reviewing right now):
 *  - "round":   below the cap, agent addressing findings, more rounds left (amber = in progress).
 *               Also covers a transient error verdict that holds the streak with no findings.
 *  - "final":   cap-th steer just delivered (`finalRoundPending`), agent addressing the
 *               last allowed round (warn = caution, last chance). Escalates to "stalled" after
 *               the verdict's `finalRoundTimeoutMs` if no re-review lands (agent abandoned it).
 *  - "stalled": cap reached and that final round already failed re-review, OR the pending
 *               final round timed out → needs a human (blocked red).
 * `now` is the current time (ms); pass a reactive clock so the timeout escalation is live.
 */
export function addressRoundInfo(
  v: ReviewVerdict | undefined,
  now: number,
): { round: number; cap: number; status: AddressStatus } | null {
  if (!v || v.addressRound <= 0) return null;
  const cap = v.addressCap;
  // Clamp the displayed numerator to the cap. The stored round can exceed the cap when the
  // operator lowers the global cap mid-streak (it holds an over-cap streak rather than
  // steering further — see runAutoAddress); without this the badge would read e.g. "3/2".
  // The streak still escalates correctly; this only keeps the counter from reading past 100%.
  const round = Math.min(v.addressRound, cap);
  // Delegate the tri-state status decision to the shared predicate (mirrored from src/review-status.ts).
  const status = addressStallStatus(v, now);
  return { round, cap, status };
}
