import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // #3515: the pre-execution plan dialog reads like the epic draft — contents, the verdict as a
  // card, the plan as a typeset document, a pinned footer. No targetId: the dialog opens on demand
  // from the plan chip, so there is no always-visible anchor (like plan-reopen-execution).
  id: "plan-review-reading",
  sinceVersion: "2.6.0",
  titleKey: "feat_plan_reading_title",
  bodyKey: "feat_plan_reading_body",
} satisfies FeatureAnnouncement;
