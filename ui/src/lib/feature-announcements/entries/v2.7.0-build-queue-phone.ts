import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // coachTarget "build-queue-edit" is the phone-only Edit button, rendered while
  // an unapproved queue with steps is being read on the phone layout.
  id: "build-queue-phone",
  sinceVersion: "2.7.0",
  titleKey: "feat_build_queue_phone_title",
  bodyKey: "feat_build_queue_phone_body",
  targetId: "build-queue-edit",
} satisfies FeatureAnnouncement;

export default entry;
