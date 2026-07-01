import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the gear item only exists when a plugin publishes one, so there
  // is no stable always-present anchor — surface via the What's-New drawer only.
  // 1.38.0 is the latest released tag, so this ships in 1.39.0.
  id: "plugin-gear-item",
  sinceVersion: "1.39.0",
  titleKey: "feat_plugin_gear_item_title",
  bodyKey: "feat_plugin_gear_item_body",
} satisfies FeatureAnnouncement;

export default entry;
