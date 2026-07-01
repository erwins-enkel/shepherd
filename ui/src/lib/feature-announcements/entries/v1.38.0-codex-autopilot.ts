import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Autopilot-until-PR is now selectable for Codex tasks (previously Claude-only). The
  // checkbox carries coachTarget "task-autopilot" in NewTaskRunSettings, so the coachmark
  // can point at it.
  id: "codex-autopilot",
  sinceVersion: "1.38.0",
  titleKey: "feat_codex_autopilot_title",
  bodyKey: "feat_codex_autopilot_body",
  targetId: "task-autopilot",
} satisfies FeatureAnnouncement;

export default entry;
