import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // Right-click / long-press menu on a herd epic group's header and session-less note
  // (EpicGroupMenu): run commands, approve next, unqueue, mode, details, issue, diagnose, assistant.
  id: "epic-menu",
  sinceVersion: "2.8.0",
  titleKey: "feat_epic_menu_title",
  bodyKey: "feat_epic_menu_body",
} satisfies FeatureAnnouncement;
