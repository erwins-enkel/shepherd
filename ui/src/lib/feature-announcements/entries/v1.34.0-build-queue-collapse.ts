import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // targetId "build-queue-collapse" anchors the coachmark on the collapse toggle
  // button in the BuildQueuePanel header. The panel only mounts when the build-queue
  // flag is on (or a queue exists), but the button is always mounted while the panel
  // is visible. 1.33.0 is the latest released tag, so this ships in 1.34.0.
  id: "build-queue-collapse",
  sinceVersion: "1.34.0",
  titleKey: "feat_build_queue_collapse_title",
  bodyKey: "feat_build_queue_collapse_body",
  targetId: "build-queue-collapse",
} satisfies FeatureAnnouncement;

export default entry;
