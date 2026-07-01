import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the repo-status band only renders when a repo has an active drain
  // or pending learnings, so a coachmark anchor would often be unmounted — surface
  // via the What's-New drawer only.
  id: "repo-status-filter",
  sinceVersion: "1.20.0",
  titleKey: "feat_repo_filter_title",
  bodyKey: "feat_repo_filter_body",
} satisfies FeatureAnnouncement;

export default entry;
