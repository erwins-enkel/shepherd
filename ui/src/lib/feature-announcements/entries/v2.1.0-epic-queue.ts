import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Starting an epic while another leads can queue it instead of superseding (#2624): it starts on
  // its own once the leader is complete. No targetId: the choice lives in the Start dialog.
  id: "epic-queue",
  sinceVersion: "2.1.0",
  titleKey: "feat_epic_queue_title",
  bodyKey: "feat_epic_queue_body",
} satisfies FeatureAnnouncement;

export default entry;
