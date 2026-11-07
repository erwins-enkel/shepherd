import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // #2596: `/goal` under the plan gate. The chip only renders while a session has a goal, so
  // the coachmark anchors to it in the focused view when one is visible.
  id: "goal-plan-gate",
  sinceVersion: "2.7.0",
  titleKey: "feat_goal_plan_gate_title",
  bodyKey: "feat_goal_plan_gate_body",
  targetId: "goal-chip",
} satisfies FeatureAnnouncement;
