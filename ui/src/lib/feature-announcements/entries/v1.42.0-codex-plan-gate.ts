import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Plan-gate is now selectable for Codex tasks (TASK-413): the gate directive rides inline on the
  // Codex spawn prompt, and the detection/review/release loop is CLI-agnostic. Anchored to the
  // plan-gate checkbox via use:coachTarget={"plan-gate"} in NewTaskRunSettings.
  id: "codex-plan-gate",
  sinceVersion: "1.42.0",
  titleKey: "feat_codex_plan_gate_title",
  bodyKey: "feat_codex_plan_gate_body",
  targetId: "plan-gate",
} satisfies FeatureAnnouncement;

export default entry;
