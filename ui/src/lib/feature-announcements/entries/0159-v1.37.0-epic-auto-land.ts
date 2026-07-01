import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // With auto-merge enabled, an integrated epic's landing PR now lands automatically once it's
  // CLEAN + CI-green (the manual "Land epic" CTA still works). Migration-bearing epics are held
  // for manual review. No targetId — server-driven behavior with no persistent anchor; surface
  // via the What's-New drawer only. v1.36.0 → ships in 1.37.0.
  id: "epic-auto-land",
  sinceVersion: "1.37.0",
  titleKey: "feat_epic_auto_land_title",
  bodyKey: "feat_epic_auto_land_body",
} satisfies FeatureAnnouncement;

export default entry;
