import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // The task ID on every card is now a button: copy it, or have a second agent (Opus /
  // GPT-5.5) analyze the session's terminal history and recommend the next prompt to send.
  // No targetId — the trigger is per-card (many instances), so there's no single coach anchor.
  id: "task-id-prompt-recommendation",
  sinceVersion: "1.37.0",
  titleKey: "feat_taskid_recommend_title",
  bodyKey: "feat_taskid_recommend_body",
} satisfies FeatureAnnouncement;

export default entry;
