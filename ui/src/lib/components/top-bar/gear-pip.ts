import type { DiagnosticState } from "#lib/types.js";

export type GearPipTier = "red" | "yellow" | "info" | null;

/** Settings-owned diagnostics attention as a pip: the phone's Menu tab (its sheet holds the
 *  Diagnose row) and the folded gear. Herd state stays on the tallies / status line. */
export function diagnosticsPip(diagnosticsOverall: DiagnosticState): "red" | "yellow" | null {
  if (diagnosticsOverall === "error") return "red";
  if (diagnosticsOverall === "warning") return "yellow";
  return null;
}

/** Fold the unread weekly steering digest (#4176) into a pip: blue "info" below any stronger
 *  tier. Shown on every gear (folded or not) — the digest's only top-level affordance. */
export function withSteeringPip(tier: GearPipTier, steeringUnread: boolean): GearPipTier {
  return tier ?? (steeringUnread ? "info" : null);
}
