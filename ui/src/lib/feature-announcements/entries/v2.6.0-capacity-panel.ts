import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // Usage gauge and held-tasks badge merged into one top-bar control whose panel shows the usage
  // windows beside what they hold back (held tasks, usage-paused drains), hold limit on the bars.
  id: "capacity-panel",
  sinceVersion: "2.6.0",
  titleKey: "feat_capacity_panel_title",
  bodyKey: "feat_capacity_panel_body",
} satisfies FeatureAnnouncement;
