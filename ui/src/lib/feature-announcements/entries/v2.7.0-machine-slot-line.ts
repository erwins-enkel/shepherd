import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // A mirrored session's slot line names the machine whose check slot it waits on or holds.
  id: "machine-slot-line",
  sinceVersion: "2.7.0",
  titleKey: "feat_machine_slot_line_title",
  bodyKey: "feat_machine_slot_line_body",
} satisfies FeatureAnnouncement;
