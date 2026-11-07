import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // The detail view's bottom strip, shown only while CI is overdue or the session goes in
  // circles, so no targetId: the anchor rarely exists when the drawer opens.
  id: "ci-overdue-loop-actions",
  sinceVersion: "2.7.0",
  titleKey: "feat_ci_overdue_loop_actions_title",
  bodyKey: "feat_ci_overdue_loop_actions_body",
} satisfies FeatureAnnouncement;
