import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // First task for a new repo now shows an inline confirm step in the New Task dialog
  // so users can review and adjust automation settings before the first spawn. The repo
  // is seeded with plan-gate ON. Subsequent tasks on the same repo spawn silently.
  // No targetId — the confirm step is transient (shown only once per repo); no
  // persistently-mounted anchor for a coachmark. v1.36.0 → ships in 1.37.0.
  id: "first-task-confirm",
  sinceVersion: "1.37.0",
  titleKey: "feat_first_task_confirm_title",
  bodyKey: "feat_first_task_confirm_body",
} satisfies FeatureAnnouncement;

export default entry;
