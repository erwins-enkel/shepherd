import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // The Issues tab's overview (nothing selected) says what runs, how issues are labelled, what
  // has lain untouched and what to do next (#2638). No targetId: the overview only mounts once a
  // repo is selected in the Repos dialog, so there is no stable anchor on first view.
  id: "repo-overview",
  sinceVersion: "2.1.0",
  titleKey: "feat_repo_overview_title",
  bodyKey: "feat_repo_overview_body",
} satisfies FeatureAnnouncement;

export default entry;
