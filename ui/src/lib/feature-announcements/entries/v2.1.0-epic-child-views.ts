import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Repos → Issues detail (#2622): an epic's task shows its standing in the epic or its live
  // session, and with nothing selected the detail gives a repo overview. No targetId: the
  // views only mount inside the Repos dialog.
  id: "epic-child-views",
  sinceVersion: "2.1.0",
  titleKey: "feat_epic_child_views_title",
  bodyKey: "feat_epic_child_views_body",
} satisfies FeatureAnnouncement;

export default entry;
