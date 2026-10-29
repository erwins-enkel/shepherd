import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // Hover copy button on code blocks in chat replies (MarkdownBody `copyCode`, ChatView).
  id: "chat-copy-code",
  sinceVersion: "2.7.0",
  titleKey: "feat_chat_copy_code_title",
  bodyKey: "feat_chat_copy_code_body",
} satisfies FeatureAnnouncement;
