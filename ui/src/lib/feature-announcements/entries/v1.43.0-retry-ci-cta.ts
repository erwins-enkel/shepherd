import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the Retry CI CTA only mounts on a row whose PR has failing CI (a ci-red hold),
  // so a coachmark anchor would rarely be present — surface via the What's-New drawer only.
  id: "retry-ci-cta",
  sinceVersion: "1.43.0",
  titleKey: "feat_retry_ci_cta_title",
  bodyKey: "feat_retry_ci_cta_body",
} satisfies FeatureAnnouncement;

export default entry;
