import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the action is inside a context menu that only mounts after
  // right-click or long-press, so surface it through What's-New only.
  id: "repo-chip-automation-settings",
  sinceVersion: "1.44.0",
  titleKey: "feat_repo_chip_automation_settings_title",
  bodyKey: "feat_repo_chip_automation_settings_body",
} satisfies FeatureAnnouncement;

export default entry;
