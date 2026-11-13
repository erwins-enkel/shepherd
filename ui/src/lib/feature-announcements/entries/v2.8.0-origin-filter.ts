import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // Herd origin filter (#3999): narrow the list to scheduled, auto-drain or manual sessions.
  id: "origin-filter",
  sinceVersion: "2.8.0",
  titleKey: "feat_origin_filter_title",
  bodyKey: "feat_origin_filter_body",
} satisfies FeatureAnnouncement;
