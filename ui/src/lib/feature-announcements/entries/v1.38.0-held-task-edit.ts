import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Held tasks now carry an "Edit" button that reopens the original New Task dialog
  // pre-filled from the task's stored input, so you can fix the prompt / repo / settings
  // before it spawns. No targetId — the held-task popover only mounts when the queue is
  // non-empty. 1.37.0 is the latest released tag, so this ships in 1.38.0.
  id: "held-task-edit",
  sinceVersion: "1.38.0",
  titleKey: "feat_held_edit_title",
  bodyKey: "feat_held_edit_body",
} satisfies FeatureAnnouncement;

export default entry;
