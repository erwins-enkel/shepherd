/**
 * Shared review-status predicate.
 * Mirror pair: src/review-status.ts — keep both files byte-identical in logic.
 */
import type { ReviewVerdict } from "./types";

export type AddressStallStatus = "round" | "final" | "stalled";

/**
 * Pure tri-state decision for an auto-address streak's current status.
 *  - "round":   below cap, or findings empty (transient error holds the streak)
 *  - "final":   at/over cap, finalRoundPending=true, and not yet timed out
 *  - "stalled": at/over cap with no pending round, or pending round has timed out
 *
 * `now` is a ms timestamp (Date.now() or a reactive clock).
 */
export function addressStallStatus(v: ReviewVerdict, now: number): AddressStallStatus {
  const cap = v.addressCap;
  const round = Math.min(v.addressRound, cap);
  if (round < cap || v.findings.length === 0) return "round";
  if (!v.finalRoundPending) return "stalled";
  if (now - v.updatedAt > v.finalRoundTimeoutMs) return "stalled";
  return "final";
}
