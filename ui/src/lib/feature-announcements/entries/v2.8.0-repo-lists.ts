import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: both lists live in the repo settings window, which is not mounted on first view.
  id: "repo-lists",
  sinceVersion: "2.8.0",
  titleKey: "feat_repo_lists_title",
  bodyKey: "feat_repo_lists_body",
} satisfies FeatureAnnouncement;

export default entry;
