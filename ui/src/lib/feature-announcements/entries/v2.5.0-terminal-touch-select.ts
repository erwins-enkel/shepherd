import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  id: "terminal-touch-select",
  sinceVersion: "2.5.0",
  titleKey: "feat_terminal_touch_select_title",
  bodyKey: "feat_terminal_touch_select_body",
  // No targetId: the Select chip lives in the touch key row, and the only
  // <Coachmark> host (GitRail) is desktop chrome.
} satisfies FeatureAnnouncement;
