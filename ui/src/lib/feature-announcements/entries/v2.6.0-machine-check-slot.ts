import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // Settings → Machines shows each connected machine's check slot: budget, queue, brake, RAM.
  id: "machine-check-slot",
  sinceVersion: "2.6.0",
  titleKey: "feat_machine_check_slot_title",
  bodyKey: "feat_machine_check_slot_body",
} satisfies FeatureAnnouncement;
