import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // A finished selection copies in the Chat and in a connected machine's terminal too.
  id: "copy-on-select-chat",
  sinceVersion: "2.8.0",
  titleKey: "feat_copy_on_select_chat_title",
  bodyKey: "feat_copy_on_select_chat_body",
} satisfies FeatureAnnouncement;
