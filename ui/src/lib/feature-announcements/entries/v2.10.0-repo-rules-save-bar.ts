import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Sticky save bar for staged repo rules (#4274). No targetId: it only appears while rules are staged.
  id: "repo-rules-save-bar",
  sinceVersion: "2.10.0",
  titleKey: "feat_repo_rules_save_bar_title",
  bodyKey: "feat_repo_rules_save_bar_body",
} satisfies FeatureAnnouncement;

export default entry;
