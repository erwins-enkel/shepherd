import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // The docked assistant's width is dragged at its left edge, replacing the top bar's layout switch.
  id: "assistant-resize",
  sinceVersion: "2.7.0",
  titleKey: "feat_assistant_resize_title",
  bodyKey: "feat_assistant_resize_body",
} satisfies FeatureAnnouncement;
