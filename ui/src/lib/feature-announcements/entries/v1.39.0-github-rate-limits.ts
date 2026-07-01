import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the GitHub tab lives inside the Usage modal, which isn't mounted
  // until opened — no stable always-present anchor. What's-New drawer only.
  id: "github-rate-limits",
  sinceVersion: "1.39.0",
  titleKey: "feat_github_rate_limits_title",
  bodyKey: "feat_github_rate_limits_body",
} satisfies FeatureAnnouncement;

export default entry;
