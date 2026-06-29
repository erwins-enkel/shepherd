import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the gauges live inside the usage popover (opened from the topbar usage
  // button), not a persistently-mounted anchor — surface via the What's-New drawer only.
  id: "codex-usage-gauges",
  sinceVersion: "1.39.0",
  titleKey: "feat_codex_usage_gauges_title",
  bodyKey: "feat_codex_usage_gauges_body",
} satisfies FeatureAnnouncement;

export default entry;
