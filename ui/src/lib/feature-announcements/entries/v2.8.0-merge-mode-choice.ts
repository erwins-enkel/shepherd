import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the choice lives in the repo settings window, which opens from context menus and
  // the ⚙ pill — none of them mounted on first view — so it surfaces through What's-New only.
  id: "merge-mode-choice",
  sinceVersion: "2.8.0",
  titleKey: "feat_merge_mode_choice_title",
  bodyKey: "feat_merge_mode_choice_body",
} satisfies FeatureAnnouncement;

export default entry;
