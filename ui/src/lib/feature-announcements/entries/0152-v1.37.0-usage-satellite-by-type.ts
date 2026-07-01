import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Satellite-by-type breakdown in the Usage → Overhead lens. No targetId — the
  // "Satellite by type" section is hidden whenever no satellite passes ran in the selected
  // range, so a coachTarget anchor may never mount; surface via the What's-New drawer only.
  // v1.36.0 is the latest released tag → ships in 1.37.0.
  id: "usage-satellite-by-type",
  sinceVersion: "1.37.0",
  titleKey: "feat_usage_satellite_by_type_title",
  bodyKey: "feat_usage_satellite_by_type_body",
} satisfies FeatureAnnouncement;

export default entry;
