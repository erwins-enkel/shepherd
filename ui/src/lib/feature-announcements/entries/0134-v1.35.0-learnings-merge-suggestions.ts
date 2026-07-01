import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Background merge-suggestion pass (#843): periodically clusters a repo's near-duplicate
  // house rules and surfaces merge groups in the Learnings drawer for one-click
  // consolidation. v1.34.0 is the latest released tag → 1.35.0.
  id: "learnings-merge-suggestions",
  sinceVersion: "1.35.0",
  titleKey: "feat_learnings_merge_title",
  bodyKey: "feat_learnings_merge_body",
} satisfies FeatureAnnouncement;

export default entry;
