import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the guardrail row only mounts on the Backlog Readiness tab once a
  // project is selected — surface via the What's-New drawer only.
  id: "readiness-swallowed-errors",
  sinceVersion: "2.9.0",
  titleKey: "feat_readiness_swallowed_errors_title",
  bodyKey: "feat_readiness_swallowed_errors_body",
} satisfies FeatureAnnouncement;

export default entry;
