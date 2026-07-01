import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the panel only mounts inside a selected session when the
  // build-queue flag is on (or a queue already exists), so a coachmark anchor
  // would rarely be mounted — surface via the What's-New drawer only.
  id: "build-queue",
  sinceVersion: "1.18.0",
  titleKey: "feat_buildqueue_title",
  bodyKey: "feat_buildqueue_body",
} satisfies FeatureAnnouncement;

export default entry;
