import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // New Task "Bootstrap" mode (#3109). No targetId: the button lives inside the New Task dialog.
  id: "bootstrap-task",
  sinceVersion: "2.2.0",
  titleKey: "feat_bootstrap_task_title",
  bodyKey: "feat_bootstrap_task_body",
} satisfies FeatureAnnouncement;

export default entry;
