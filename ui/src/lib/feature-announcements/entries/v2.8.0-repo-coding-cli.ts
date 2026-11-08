import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // Per-repo coding CLI in the automation settings, preselected by New Task (#3441).
  id: "repo-coding-cli",
  sinceVersion: "2.8.0",
  titleKey: "feat_repo_coding_cli_title",
  bodyKey: "feat_repo_coding_cli_body",
} satisfies FeatureAnnouncement;
