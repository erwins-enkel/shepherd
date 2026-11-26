import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Opt-in Aptabase telemetry removed. No targetId: the prompt and the Settings toggle are gone.
  id: "telemetry-removed",
  sinceVersion: "2.9.0",
  titleKey: "feat_telemetry_removed_title",
  bodyKey: "feat_telemetry_removed_body",
} satisfies FeatureAnnouncement;

export default entry;
