import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the tappable emoji only mounts in the phone header and only
  // when the repo has a configured icon — surface via the What's-New drawer only.
  id: "viewport-repo-icon-inline",
  sinceVersion: "1.23.0",
  titleKey: "feat_viewport_repo_icon_title",
  bodyKey: "feat_viewport_repo_icon_body",
} satisfies FeatureAnnouncement;

export default entry;
