import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Stalled plan-gate chips now open an action menu: inspect the plan, send the review
  // findings back to the planning agent, or trigger a re-review once the plan file changed.
  id: "plan-stall-menu",
  sinceVersion: "1.43.0",
  titleKey: "feat_plan_stall_menu_title",
  bodyKey: "feat_plan_stall_menu_body",
} satisfies FeatureAnnouncement;

export default entry;
