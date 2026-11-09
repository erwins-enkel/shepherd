import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // The usage panel shows each account's monthly GitHub Actions allowance and when CI would stop.
  id: "github-actions-usage",
  sinceVersion: "2.8.0",
  titleKey: "feat_github_actions_usage_title",
  bodyKey: "feat_github_actions_usage_body",
} satisfies FeatureAnnouncement;
