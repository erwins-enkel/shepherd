import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // A finished session's Done-row menu and recap panel open the Operator Assistant about that
  // task, and the assistant's herd_status now reads finished tasks (prompt + recap).
  id: "done-ask-assistant",
  sinceVersion: "2.8.0",
  titleKey: "feat_done_ask_assistant_title",
  bodyKey: "feat_done_ask_assistant_body",
} satisfies FeatureAnnouncement;
