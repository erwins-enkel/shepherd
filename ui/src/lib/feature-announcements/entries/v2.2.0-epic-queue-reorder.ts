import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // The repo run area (Repos → Issues, nothing selected) lists the queued epics; drag or ↑ / ↓
  // reorders them. Stopping the leader starts the queue's head; landing repairs hold no slot. No
  // targetId: like slot-stepper, it only mounts inside the Repos dialog.
  id: "epic-queue-reorder",
  sinceVersion: "2.2.0",
  titleKey: "feat_epic_queue_reorder_title",
  bodyKey: "feat_epic_queue_reorder_body",
} satisfies FeatureAnnouncement;

export default entry;
