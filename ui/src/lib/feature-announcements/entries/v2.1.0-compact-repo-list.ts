import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // The Repos dialog's repo list gets denser and narrower so the Issues list + reading view
  // have the width. No targetId: the list only mounts inside the Repos dialog, so there is
  // no stable anchor on first view.
  id: "compact-repo-list",
  sinceVersion: "2.1.0",
  titleKey: "feat_compact_repo_list_title",
  bodyKey: "feat_compact_repo_list_body",
} satisfies FeatureAnnouncement;

export default entry;
