import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // targetId "backlog-ff-main" anchors the coachmark on the Fast-forward button
  // at the right end of the Backlog detail tab bar. v1.34.0 is the latest released
  // tag → ships in 1.35.0.
  id: "ff-main-standalone",
  sinceVersion: "1.35.0",
  titleKey: "feat_ff_main_title",
  bodyKey: "feat_ff_main_body",
  targetId: "backlog-ff-main",
} satisfies FeatureAnnouncement;

export default entry;
