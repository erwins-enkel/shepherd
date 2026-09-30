import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // The Repos dialog's Issues tab splits into an epic-grouped list and a reading view with
  // rendered descriptions. No targetId: the list only mounts once a repo is selected in the
  // Repos dialog, so there is no stable anchor on first view.
  id: "issues-reading-view",
  sinceVersion: "2.1.0",
  titleKey: "feat_issues_reading_title",
  bodyKey: "feat_issues_reading_body",
} satisfies FeatureAnnouncement;

export default entry;
