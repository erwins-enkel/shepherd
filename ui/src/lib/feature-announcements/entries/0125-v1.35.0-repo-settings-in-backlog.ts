import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Per-repo automation settings (the in-task Automation popover) are now also a tab in
  // the Backlog drill-down, editable without launching a task. targetId "backlog-automation"
  // matches use:coachTarget on the desktop Automation tab button in BacklogView.
  // v1.34.0 is the latest released tag → ships in 1.35.0.
  id: "repo-settings-in-backlog",
  sinceVersion: "1.35.0",
  titleKey: "feat_repo_settings_backlog_title",
  bodyKey: "feat_repo_settings_backlog_body",
  targetId: "backlog-automation",
} satisfies FeatureAnnouncement;

export default entry;
