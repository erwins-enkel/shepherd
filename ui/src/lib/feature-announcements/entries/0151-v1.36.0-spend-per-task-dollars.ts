import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Per-task `$` in the Spend lens (#980): each expanded task row now shows a dollar figure
  // (api-key auth mode only), alongside the existing per-repo + grand-total `$`. No targetId —
  // task-row `$` is only visible in api-key mode inside an expanded repo row, so there's no
  // persistently-mounted anchor to point a coachmark at; surface via the What's-New drawer only.
  // v1.35.0 is the latest released tag → ships in 1.36.0.
  id: "spend-per-task-dollars",
  sinceVersion: "1.36.0",
  titleKey: "feat_spend_per_task_dollars_title",
  bodyKey: "feat_spend_per_task_dollars_body",
} satisfies FeatureAnnouncement;

export default entry;
