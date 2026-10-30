import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // New sessions queue behind the check slot's pressure brake (HeavySlotStrip, HostPopover).
  id: "start-queue-memory",
  sinceVersion: "2.7.0",
  titleKey: "feat_start_queue_memory_title",
  bodyKey: "feat_start_queue_memory_body",
} satisfies FeatureAnnouncement;
