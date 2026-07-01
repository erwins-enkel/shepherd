import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the downgrade controls live in the Settings modal (Coding agents tab),
  // closed by default — surface via the What's-New drawer only.
  id: "usage-aware-model-downgrade",
  sinceVersion: "1.39.0",
  titleKey: "feat_usage_downgrade_title",
  bodyKey: "feat_usage_downgrade_body",
} satisfies FeatureAnnouncement;

export default entry;
