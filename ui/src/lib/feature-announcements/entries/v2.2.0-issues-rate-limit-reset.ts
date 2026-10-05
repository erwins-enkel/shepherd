import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the notice only exists while GitHub rate-limits the issue list —
  // no stable always-present anchor. What's-New drawer only.
  id: "issues-rate-limit-reset",
  sinceVersion: "2.2.0",
  titleKey: "feat_issues_rate_limit_reset_title",
  bodyKey: "feat_issues_rate_limit_reset_body",
} satisfies FeatureAnnouncement;

export default entry;
