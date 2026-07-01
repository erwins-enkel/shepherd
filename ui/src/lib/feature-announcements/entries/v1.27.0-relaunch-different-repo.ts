import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // context-menu control, no fixed anchor → What's-New drawer only
  id: "relaunch-different-repo",
  sinceVersion: "1.27.0",
  titleKey: "feat_relaunch_repo_title",
  bodyKey: "feat_relaunch_repo_body",
} satisfies FeatureAnnouncement;

export default entry;
