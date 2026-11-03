import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // #3563: the plan verdict card lists what the reviewer verified. No targetId: the dialog opens on
  // demand from the plan chip, so there is no always-visible anchor (like plan-review-reading).
  id: "plan-verdict-checked",
  sinceVersion: "2.7.0",
  titleKey: "feat_plan_checked_title",
  bodyKey: "feat_plan_checked_body",
} satisfies FeatureAnnouncement;
