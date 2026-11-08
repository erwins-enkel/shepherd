import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // The host panel and chip show what is still free: slots as pips, RAM and pressure cut at the
  // brake line, and the brake's countdown while it holds on after readings calmed.
  id: "check-slot-headroom",
  sinceVersion: "2.8.0",
  titleKey: "feat_check_slot_headroom_title",
  bodyKey: "feat_check_slot_headroom_body",
} satisfies FeatureAnnouncement;
