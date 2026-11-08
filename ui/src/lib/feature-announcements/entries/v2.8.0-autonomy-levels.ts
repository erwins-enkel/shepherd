import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the levels live in the repo settings window and the context menus, none of them
  // mounted on first view — so it surfaces through What's-New only.
  id: "autonomy-levels",
  sinceVersion: "2.8.0",
  titleKey: "feat_autonomy_levels_title",
  bodyKey: "feat_autonomy_levels_body",
} satisfies FeatureAnnouncement;

export default entry;
