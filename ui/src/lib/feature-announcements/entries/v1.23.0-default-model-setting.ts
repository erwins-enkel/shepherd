import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the control lives inside the Settings modal (closed by default),
  // so a coachmark anchor would rarely be mounted — surface via the What's-New drawer only.
  // v1.22.0 is already tagged, so this ships in the next release (1.23.0).
  id: "default-model-setting",
  sinceVersion: "1.23.0",
  titleKey: "feat_default_model_title",
  bodyKey: "feat_default_model_body",
} satisfies FeatureAnnouncement;

export default entry;
