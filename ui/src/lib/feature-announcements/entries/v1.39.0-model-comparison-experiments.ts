import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: "Start as variant…" / "Continue with…" live in a card's context menu and the
  // "Compare" button only mounts on an experiment group's header (present only once variants
  // exist), so there's no always-present anchor — surface via the What's-New drawer only.
  // 1.38.0 is the latest released tag, so this ships in 1.39.0.
  id: "model-comparison-experiments",
  sinceVersion: "1.39.0",
  titleKey: "feature_model_comparison_title",
  bodyKey: "feature_model_comparison_body",
} satisfies FeatureAnnouncement;

export default entry;
