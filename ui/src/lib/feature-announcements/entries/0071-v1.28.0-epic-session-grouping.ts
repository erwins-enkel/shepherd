import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: epic groups only render when an active epic has ≥1 child session,
  // so the headline anchor isn't reliably present — surface via the What's-New drawer
  // only. v1.27.0 is the latest released tag, so this ships in 1.28.0.
  id: "epic-session-grouping",
  sinceVersion: "1.28.0",
  titleKey: "feat_epic_grouping_title",
  bodyKey: "feat_epic_grouping_body",
} satisfies FeatureAnnouncement;

export default entry;
