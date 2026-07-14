import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // coachTarget "build-queue-progress" is on the BuildQueueBadge control itself
  // (conditionally rendered when approved + steps > 0). 1.33.0 is the latest
  // released tag, so this ships in 1.34.0.
  id: "build-queue-progress",
  sinceVersion: "1.34.0",
  titleKey: "feat_build_queue_progress_title",
  bodyKey: "feat_build_queue_progress_body",
  targetId: "build-queue-progress",
} satisfies FeatureAnnouncement;

export default entry;
