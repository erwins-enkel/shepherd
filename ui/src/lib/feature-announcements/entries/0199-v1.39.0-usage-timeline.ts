import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // New Timeline tab in the Usage modal: a day×hour heatmap of weighted-unit consumption.
  // No targetId — the Usage modal isn't mounted until opened, so there's no stable anchor
  // (same rationale as github-rate-limits). What's-New drawer only.
  id: "usage-timeline",
  sinceVersion: "1.39.0",
  titleKey: "feat_usage_timeline_title",
  bodyKey: "feat_usage_timeline_body",
} satisfies FeatureAnnouncement;

export default entry;
