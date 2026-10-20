import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Incremental epics stack their children too (#3197); no new UI surface, so no targetId.
  id: "epic-incremental-stacks",
  sinceVersion: "2.2.0",
  titleKey: "feat_epic_incremental_stacks_title",
  bodyKey: "feat_epic_incremental_stacks_body",
} satisfies FeatureAnnouncement;

export default entry;
