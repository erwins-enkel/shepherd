import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Landing toggle beside the epic run area's mode toggle + the landing choice in the epic draft
  // modal (#3191). No targetId: both only mount inside dialogs.
  id: "epic-incremental-landing",
  sinceVersion: "2.2.0",
  titleKey: "feat_epic_incremental_landing_title",
  bodyKey: "feat_epic_incremental_landing_body",
} satisfies FeatureAnnouncement;

export default entry;
