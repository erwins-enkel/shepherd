import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // The Backlog's Automation tab became Settings and embeds the repo settings window's body.
  // targetId "backlog-automation" matches use:coachTarget on the desktop tab in BacklogTabBar.
  id: "backlog-settings-tab",
  sinceVersion: "2.8.0",
  titleKey: "feat_backlog_settings_tab_title",
  bodyKey: "feat_backlog_settings_tab_body",
  targetId: "backlog-automation",
} satisfies FeatureAnnouncement;

export default entry;
