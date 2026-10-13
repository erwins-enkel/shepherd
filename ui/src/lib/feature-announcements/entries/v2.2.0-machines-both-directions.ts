import type { FeatureAnnouncement } from "../../feature-announcements";

// No targetId: the incoming list lives in Settings → Machines, which is closed at announce time.
export default {
  id: "machines-both-directions",
  sinceVersion: "2.2.0",
  titleKey: "feat_machines_both_directions_title",
  bodyKey: "feat_machines_both_directions_body",
} satisfies FeatureAnnouncement;
