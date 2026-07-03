import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Settings now surfaces whether your installed plugins have a newer released version —
  // an informational check (via a declared repository or a git checkout), no auto-apply.
  id: "plugin-updates",
  sinceVersion: "1.42.0",
  titleKey: "feat_plugin_updates_title",
  bodyKey: "feat_plugin_updates_body",
} satisfies FeatureAnnouncement;

export default entry;
