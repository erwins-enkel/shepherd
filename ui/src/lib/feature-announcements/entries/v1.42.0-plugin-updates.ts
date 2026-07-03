import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Settings surfaces whether your installed plugins have a newer released version (via a
  // declared repository or a git checkout) AND applies it in place with one click — a
  // re-verified fetch-and-swap on disk, then a live re-activation (or a restart hint).
  id: "plugin-updates",
  sinceVersion: "1.42.0",
  titleKey: "feat_plugin_updates_title",
  bodyKey: "feat_plugin_updates_body",
} satisfies FeatureAnnouncement;

export default entry;
