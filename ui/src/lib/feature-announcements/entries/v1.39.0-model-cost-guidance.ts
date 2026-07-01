import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the guidance appears inside Settings and transient picker popovers,
  // which are usually unmounted on first view. Surface via the What's-New drawer only.
  id: "model-cost-guidance",
  sinceVersion: "1.39.0",
  titleKey: "feat_model_cost_guidance_title",
  bodyKey: "feat_model_cost_guidance_body",
} satisfies FeatureAnnouncement;

export default entry;
