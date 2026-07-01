import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // targetId "task-autopilot" anchors the coachmark on the per-task Autopilot
  // checkbox in the New Task dialog. 1.31.0 is the latest released tag, so this
  // ships in 1.32.0.
  id: "task-autopilot-override",
  sinceVersion: "1.32.0",
  titleKey: "feat_task_autopilot_title",
  bodyKey: "feat_task_autopilot_body",
  targetId: "task-autopilot",
} satisfies FeatureAnnouncement;

export default entry;
