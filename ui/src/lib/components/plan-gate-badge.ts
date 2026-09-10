import type { PlanGate, Session } from "../types";
import { planStallStatus } from "../plan-status";

/**
 * Which plan-gate chip a session card should show, or "none" to hide it.
 * Pure state selection so it can be unit-tested without rendering.
 *
 * Priority order:
 *  - "none":       planPhase is null (no gate active), OR planPhase is "executing"
 *                  with no persisted gate (nothing to show), OR planPhase is
 *                  "executing" but the caller opted out of the "view" chip
 *                  (`allowView: false`) — see below.
 *  - "edited":     planPhase is "executing", the gate is approved, and the live plan
 *                  has since been edited (#2224) — same read-only surface as "view",
 *                  but it says the shown plan is no longer what the agent is working
 *                  from, and it is the state in which a re-review can be triggered.
 *  - "view":       planPhase is "executing" AND a persisted gate exists AND the
 *                  caller allows it (`allowView`, default true) — surfaces the
 *                  signed-off plan read-only so the operator can re-open it during
 *                  execution (issue #809). No Go/Review actions are shown. The
 *                  dense session-list surface (UnitRow) passes
 *                  `allowView: false` to keep this read-only chip off the cards;
 *                  it then lives only in the per-session top bar.
 *  - "reviewing":  the plan reviewer is running now — wins over any stale verdict.
 *  - "changes":    last verdict requested changes — shows the round/cap counter.
 *  - "ready":      verdict approved and still in "planning" → operator can hit Go.
 *  - "error":      reviewer errored.
 *  - "planning":   in the plan phase, no verdict yet.
 */
export type PlanGateChip =
  | { kind: "none" }
  | { kind: "view" }
  | { kind: "edited" }
  | { kind: "reviewing" }
  | { kind: "changes"; round: number; cap: number }
  | { kind: "ready" }
  | { kind: "error" }
  | { kind: "planning" };

export function planGateChip(
  session: Pick<Session, "planPhase">,
  gate: PlanGate | undefined,
  reviewing: boolean,
  opts: { allowView?: boolean } = {},
): PlanGateChip {
  const { allowView = true } = opts;
  if (session.planPhase == null) return { kind: "none" };
  // Executing: the gate already passed — surface the signed-off plan read-only (issue #809),
  // but only while a persisted gate still exists and the caller opts in (`allowView`).
  // The dense session-list surfaces opt out so this chip lives only in the top bar.
  if (session.planPhase === "executing") {
    if (!gate || !allowView) return { kind: "none" };
    return planEdited(gate) ? { kind: "edited" } : { kind: "view" };
  }
  if (reviewing) return { kind: "reviewing" };
  if (gate?.decision === "changes_requested") {
    return { kind: "changes", round: gate.round, cap: gate.cap };
  }
  if (gate?.approved) return { kind: "ready" };
  if (gate?.decision === "error") return { kind: "error" };
  return { kind: "planning" };
}

/** Whether the live `.shepherd-plan.md` has diverged from the plan this gate APPROVED (#2224).
 *  The server re-hashes the file on each settle edge and stores it as `livePlanHash`; a gate that
 *  has never been checked (or predates the field) carries null and reads as un-edited. Only an
 *  approved gate can be "edited" in this sense — before approval the plan is expected to move. */
export function planEdited(gate: PlanGate | undefined): boolean {
  return Boolean(gate?.approved && gate.livePlanHash && gate.livePlanHash !== gate.planHash);
}

/** Whether the operator may release the gate (Go) for this session. */
export function canRelease(
  session: Pick<Session, "planPhase">,
  gate: PlanGate | undefined,
): boolean {
  return Boolean(gate?.approved) && session.planPhase === "planning";
}

export function canShowPlanStallActions(
  session: Pick<Session, "planPhase" | "status">,
  gate: PlanGate | undefined,
  reviewing: boolean,
): boolean {
  return Boolean(
    session.planPhase === "planning" &&
    session.status !== "running" &&
    !reviewing &&
    gate?.decision === "changes_requested" &&
    gate.round >= gate.cap,
  );
}

/** Whether the badge should read as *genuinely stalled* (amber toning + stall-recovery menu):
 *  the operator can act now (`canShowPlanStallActions`) AND the rework streak is truly stuck
 *  (`planStallStatus === "stalled"` — NOT a fresh `final` round the agent is still revising).
 *  `now` is a ms clock (reactive `clock.current`). Supersedes the old chip-only heuristic that
 *  toned every at-cap `changes` chip amber, including a live final round (issue #1610). */
export function planGateStalledNow(
  session: Pick<Session, "planPhase" | "status">,
  gate: PlanGate | undefined,
  reviewing: boolean,
  now: number,
): boolean {
  return (
    gate != null &&
    canShowPlanStallActions(session, gate, reviewing) &&
    planStallStatus(gate, now) === "stalled"
  );
}

/** Reason a manual plan re-review is BLOCKED on GitRail / PlanPanel, or null when it can start.
 *  `reviewing` (one already in flight) is checked BEFORE `approved` — matching planGateChip() — so a
 *  review landing on a just-approved gate reads as in-flight, not "already approved". After the
 *  `force` seam an unchanged/at-cap plan is no longer a block (force re-reviews it); only these two
 *  states remain genuinely un-startable. Callers gate VISIBILITY on canOfferPlanReview. */
export type PlanReviewBlockReason = "reviewing" | "approved";

export function canTriggerPlanReview(
  session: Pick<Session, "planPhase">,
  gate: PlanGate | undefined,
  reviewing: boolean,
): PlanReviewBlockReason | null {
  if (!canOfferPlanReview(session, gate)) return null; // control isn't offered here at all
  if (reviewing) return "reviewing";
  // An EDITED approved plan is re-reviewable (#2224) — that is the one bypass the server honours.
  if (gate?.approved && !planEdited(gate)) return "approved";
  return null;
}

/** Whether the manual plan-review control belongs on screen for this session at all (#2224).
 *  Planning: always, as before. Executing: only when the approved plan has since been edited —
 *  the sole state where the server will run a re-review, and one whose verdict can re-gate the
 *  session. Every other executing session keeps the read-only plan view with no controls. */
export function canOfferPlanReview(
  session: Pick<Session, "planPhase">,
  gate: PlanGate | undefined,
): boolean {
  if (session.planPhase === "planning") return true;
  return session.planPhase === "executing" && planEdited(gate);
}

export type PlanGateTooltipCopy = {
  fallback: string;
  planning: string;
  reviewing: string;
  changes: string;
  changesStalled: string;
  ready: string;
  error: string;
  view: string;
  edited: string;
};

/** Compose the badge tooltip without replacing the reviewer's own one-line summary. */
export function composePlanGateTooltip(
  chip: PlanGateChip,
  gate: Pick<PlanGate, "summary"> | undefined,
  copy: PlanGateTooltipCopy,
  opts: { stalledActionsVisible?: boolean } = {},
): string {
  if (chip.kind === "none") return "";
  const hint = planGateTooltipHint(chip, copy, opts);
  const summary = gate?.summary?.trim();
  return summary ? `${summary}; ${hint}` : hint || copy.fallback;
}

function planGateTooltipHint(
  chip: PlanGateChip,
  copy: PlanGateTooltipCopy,
  opts: { stalledActionsVisible?: boolean },
): string {
  switch (chip.kind) {
    case "planning":
      return copy.planning;
    case "reviewing":
      return copy.reviewing;
    case "changes":
      return chip.round >= chip.cap && opts.stalledActionsVisible
        ? copy.changesStalled
        : copy.changes;
    case "ready":
      return copy.ready;
    case "error":
      return copy.error;
    case "view":
      return copy.view;
    case "edited":
      return copy.edited;
    case "none":
      return "";
  }
}
