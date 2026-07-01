import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the popover is hover-revealed (not persistently mounted), so a
  // coachmark anchor would never exist — surface via the What's-New drawer only.
  // v1.23.0 is already tagged, so this ships in the next release (1.24.0).
  id: "tile-time-tooltip",
  sinceVersion: "1.24.0",
  titleKey: "feat_time_tooltip_title",
  bodyKey: "feat_time_tooltip_body",
} satisfies FeatureAnnouncement;

export default entry;
