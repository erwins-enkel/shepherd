import type { PlanGate, Session } from "../types";

/**
 * Which plan-gate chip a session card should show, or "none" to hide it.
 * Pure state selection so it can be unit-tested without rendering.
 *
 * Priority order:
 *  - "none":       planPhase is null (no gate active), OR planPhase is "executing"
 *                  with no persisted gate (nothing to show), OR planPhase is
 *                  "executing" but the caller opted out of the "view" chip
 *                  (`allowView: false`) — see below.
 *  - "view":       planPhase is "executing" AND a persisted gate exists AND the
 *                  caller allows it (`allowView`, default true) — surfaces the
 *                  signed-off plan read-only so the operator can re-open it during
 *                  execution (issue #809). No Go/Review actions are shown. The
 *                  dense session-list surfaces (UnitRow/UnitTile) pass
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
  | { kind: "reviewing" }
  | { kind: "changes"; round: number; cap: number }
  | { kind: "ready" }
  | { kind: "error" }
  | { kind: "planning" };

export function planGateStalled(chip: PlanGateChip): boolean {
  return chip.kind === "changes" && chip.round >= chip.cap;
}

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
    return gate && allowView ? { kind: "view" } : { kind: "none" };
  }
  if (reviewing) return { kind: "reviewing" };
  if (gate?.decision === "changes_requested") {
    return { kind: "changes", round: gate.round, cap: gate.cap };
  }
  if (gate?.approved) return { kind: "ready" };
  if (gate?.decision === "error") return { kind: "error" };
  return { kind: "planning" };
}

/** Whether the operator may release the gate (Go) for this session. */
export function canRelease(
  session: Pick<Session, "planPhase">,
  gate: PlanGate | undefined,
): boolean {
  return Boolean(gate?.approved) && session.planPhase === "planning";
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
};

/** Compose the badge tooltip without replacing the reviewer's own one-line summary. */
export function composePlanGateTooltip(
  chip: PlanGateChip,
  gate: Pick<PlanGate, "summary"> | undefined,
  copy: PlanGateTooltipCopy,
): string {
  if (chip.kind === "none") return "";
  const hint = planGateTooltipHint(chip, copy);
  const summary = gate?.summary?.trim();
  return summary ? `${summary}; ${hint}` : hint || copy.fallback;
}

function planGateTooltipHint(chip: PlanGateChip, copy: PlanGateTooltipCopy): string {
  switch (chip.kind) {
    case "planning":
      return copy.planning;
    case "reviewing":
      return copy.reviewing;
    case "changes":
      return chip.round >= chip.cap ? copy.changesStalled : copy.changes;
    case "ready":
      return copy.ready;
    case "error":
      return copy.error;
    case "view":
      return copy.view;
    case "none":
      return "";
  }
}
