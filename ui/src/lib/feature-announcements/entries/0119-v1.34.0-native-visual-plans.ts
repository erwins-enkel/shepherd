import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: PlanPanel is an on-demand modal (closed by default), so there's no
  // stable always-visible anchor for a coachmark — surface via the What's-New drawer
  // only. 1.33.0 is the latest released tag, so this ships in 1.34.0.
  id: "native-visual-plans",
  sinceVersion: "1.34.0",
  titleKey: "feat_visual_plan_title",
  bodyKey: "feat_visual_plan_body",
} satisfies FeatureAnnouncement;

export default entry;
