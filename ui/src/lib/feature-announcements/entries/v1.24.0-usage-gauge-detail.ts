import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the only armed coachmarks are the automation-pill features
  // (PILL_FEATURE_IDS in GitRail.svelte), so an anchor on the gauges would never
  // fire — this entry surfaces via the What's-New drawer alone. Fitting anyway,
  // since the detail card is a desktop-only hover affordance. On desktop, hovering
  // the top-bar usage gauges now opens a detailed card (full window names, wide
  // bars, reset times) in place of the bare one-line text tooltip. v1.23.0 is
  // already tagged, so this ships in the next release (1.24.0): computeNewEntries
  // only surfaces entries with sinceVersion > lastSeen.
  id: "usage-gauge-detail",
  sinceVersion: "1.24.0",
  titleKey: "feat_usage_gauge_detail_title",
  bodyKey: "feat_usage_gauge_detail_body",
} satisfies FeatureAnnouncement;

export default entry;
