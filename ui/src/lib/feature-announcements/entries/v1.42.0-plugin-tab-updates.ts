import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // The Plugins tab itself now carries the update state: an "update available" badge +
  // Update button on each plugin's card, plus a manual "Check for updates" that re-scans
  // on demand instead of waiting for the half-hourly background check.
  id: "plugin-tab-updates",
  sinceVersion: "1.42.0",
  titleKey: "feat_plugin_tab_updates_title",
  bodyKey: "feat_plugin_tab_updates_body",
} satisfies FeatureAnnouncement;

export default entry;
