import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Top-bar search field entry point for the Cmd/Ctrl+K command bar: docs + Learnings
  // now live inside the bar, so the standalone docs icon and the learnings badge were
  // removed. Coachmark anchors on the search pill (targetId "topbar-search").
  id: "command-bar-search-field",
  sinceVersion: "1.41.0",
  titleKey: "feat_command_bar_search_field_title",
  bodyKey: "feat_command_bar_search_field_body",
  targetId: "topbar-search",
} satisfies FeatureAnnouncement;

export default entry;
