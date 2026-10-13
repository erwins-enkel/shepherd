import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Pasting a GitHub link into New Task selects the matching repo (and attaches an issue link's
  // issue). No targetId: the behavior has no anchor of its own beyond the repo picker.
  id: "repo-from-link",
  sinceVersion: "2.2.0",
  titleKey: "feat_repo_from_link_title",
  bodyKey: "feat_repo_from_link_body",
} satisfies FeatureAnnouncement;

export default entry;
