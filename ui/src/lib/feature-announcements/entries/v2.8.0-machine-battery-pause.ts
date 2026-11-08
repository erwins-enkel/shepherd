import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // A connected Mac on battery pause reads as such, not as unreachable.
  id: "machine-battery-pause",
  sinceVersion: "2.8.0",
  titleKey: "feat_machine_battery_pause_title",
  bodyKey: "feat_machine_battery_pause_body",
} satisfies FeatureAnnouncement;
