import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the task-id button is per-card, not a single stable anchor —
  // surface via the What's-New drawer only. 1.38.0 is the latest released tag.
  id: "taskid-copy-details",
  sinceVersion: "1.39.0",
  titleKey: "feat_taskid_copy_payload_title",
  bodyKey: "feat_taskid_copy_payload_body",
} satisfies FeatureAnnouncement;

export default entry;
