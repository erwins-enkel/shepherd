import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // "Decommission all" now clears only the merged sessions the repo filter shows; the dialog
  // offers the hidden repos' merged sessions through a separate "all" action.
  id: "clear-merged-repo-filter",
  sinceVersion: "2.1.0",
  titleKey: "feat_clearmerged_scope_title",
  bodyKey: "feat_clearmerged_scope_body",
} satisfies FeatureAnnouncement;

export default entry;
