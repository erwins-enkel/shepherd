import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // The session Chat gets the steer bar, and Shepherd's own steers fold into labelled rows.
  id: "chat-steers",
  sinceVersion: "2.6.0",
  titleKey: "feat_chat_steers_title",
  bodyKey: "feat_chat_steers_body",
} satisfies FeatureAnnouncement;
