import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the toggle lives in the Settings modal SESSION tab (closed by default),
  // so a coachmark anchor would rarely be mounted — surface via the What's-New drawer only.
  // v1.34.0 is the latest released tag → ships in 1.35.0.
  id: "usage-aware-holding",
  sinceVersion: "1.35.0",
  titleKey: "feat_usage_aware_holding_title",
  bodyKey: "feat_usage_aware_holding_body",
} satisfies FeatureAnnouncement;

export default entry;
