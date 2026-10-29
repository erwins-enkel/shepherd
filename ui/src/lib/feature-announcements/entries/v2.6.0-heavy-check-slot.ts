import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // Host-wide heavy-check slot (#3181): agents' tests, type checks and builds take turns. The top
  // bar chip shows the slot and its queue; each card's now-line shows its session's part in it.
  id: "heavy-check-slot",
  sinceVersion: "2.6.0",
  titleKey: "feat_heavy_slot_title",
  bodyKey: "feat_heavy_slot_body",
} satisfies FeatureAnnouncement;
