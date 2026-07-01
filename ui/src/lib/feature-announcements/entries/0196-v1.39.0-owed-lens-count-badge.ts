import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // The OWED Herd lens now wears a count badge when merged PRs still owe post-merge
  // manual steps. targetId "owed-lens" is the existing coachmark anchor on the lens
  // segment, so the coachmark points right at the badge.
  id: "owed-lens-count-badge",
  sinceVersion: "1.39.0",
  titleKey: "feat_owed_badge_title",
  bodyKey: "feat_owed_badge_body",
  targetId: "owed-lens",
} satisfies FeatureAnnouncement;

export default entry;
