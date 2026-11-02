import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // Weekly 80% usage push (attachUsagePush) + plans without a 5-hour window (Ultra).
  id: "weekly-usage-push",
  sinceVersion: "2.7.0",
  titleKey: "feat_weekly_usage_push_title",
  bodyKey: "feat_weekly_usage_push_body",
} satisfies FeatureAnnouncement;
