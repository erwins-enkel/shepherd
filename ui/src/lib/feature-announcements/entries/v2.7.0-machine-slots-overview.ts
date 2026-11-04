import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // The herd's check-slot strip and the top-bar chip show every connected machine's slot.
  id: "machine-slots-overview",
  sinceVersion: "2.7.0",
  titleKey: "feat_machine_slots_overview_title",
  bodyKey: "feat_machine_slots_overview_body",
} satisfies FeatureAnnouncement;
