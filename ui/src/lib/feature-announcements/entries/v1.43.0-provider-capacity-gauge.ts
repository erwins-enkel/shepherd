import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // The New Task form now compares Claude Code and Codex capacity side by side so operators can
  // pick the provider with the most remaining room before starting a run.
  id: "provider-capacity-gauge",
  sinceVersion: "1.43.0",
  titleKey: "feat_provider_capacity_gauge_title",
  bodyKey: "feat_provider_capacity_gauge_body",
} satisfies FeatureAnnouncement;

export default entry;
