import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the window opens from context menus and the ⚙ pill, none of them mounted on
  // first view, so it surfaces through What's-New only.
  id: "repo-settings-window",
  sinceVersion: "2.8.0",
  titleKey: "feat_repo_settings_window_title",
  bodyKey: "feat_repo_settings_window_body",
} satisfies FeatureAnnouncement;

export default entry;
