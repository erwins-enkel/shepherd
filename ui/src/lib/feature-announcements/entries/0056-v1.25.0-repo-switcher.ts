import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the chip rail only renders when ≥2 repos have a live session, so a
  // coachmark anchor would often be unmounted. Surface via the What's-New drawer only
  // (same rationale as the prior "repo-status-filter" entry it supersedes).
  id: "repo-switcher",
  sinceVersion: "1.25.0",
  titleKey: "feat_repo_switcher_title",
  bodyKey: "feat_repo_switcher_body",
} satisfies FeatureAnnouncement;

export default entry;
