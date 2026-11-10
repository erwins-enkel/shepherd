import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // Sessions on a connected machine get the full Chat tab, run on that machine.
  id: "remote-chat",
  sinceVersion: "2.8.0",
  titleKey: "feat_remote_chat_title",
  bodyKey: "feat_remote_chat_body",
} satisfies FeatureAnnouncement;
