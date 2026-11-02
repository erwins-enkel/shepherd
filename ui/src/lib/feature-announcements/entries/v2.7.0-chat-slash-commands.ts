import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the menu only exists while typing a command, so there is no anchor to point at.
  id: "chat-slash-commands",
  sinceVersion: "2.7.0",
  titleKey: "feat_chat_slash_commands_title",
  bodyKey: "feat_chat_slash_commands_body",
} satisfies FeatureAnnouncement;

export default entry;
