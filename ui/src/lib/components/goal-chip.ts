import type { Session } from "#lib/types.js";

/** What the Goal chip shows for a session's Claude Code `/goal` (#2596). */
type GoalChip =
  { kind: "none" } | { kind: "held"; condition: string } | { kind: "active"; condition: string };

/**
 * `held` shows only while the plan gate is planning: Shepherd arms the goal at Go, so a
 * held goal outside planning is stale and shows nothing. `active` shows in any phase.
 * A missing or blank condition shows nothing.
 */
export function goalChip(
  session: Pick<Session, "planPhase" | "goalState" | "goalCondition">,
): GoalChip {
  const condition = session.goalCondition?.trim();
  if (!condition) return { kind: "none" };
  if (session.goalState === "active") return { kind: "active", condition };
  if (session.goalState === "held" && session.planPhase === "planning")
    return { kind: "held", condition };
  return { kind: "none" };
}
