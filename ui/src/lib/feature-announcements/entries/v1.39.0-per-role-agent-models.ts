import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the per-role environment pickers live in the Settings modal (Coding agents
  // tab), closed by default, so a coachmark anchor would rarely be mounted — surface
  // via the What's-New drawer only.
  id: "per-role-agent-models",
  sinceVersion: "1.39.0",
  titleKey: "feat_role_models_title",
  bodyKey: "feat_role_models_body",
} satisfies FeatureAnnouncement;

export default entry;
