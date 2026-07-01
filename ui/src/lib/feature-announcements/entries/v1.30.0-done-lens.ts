import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // The DONE filter button lives in the always-visible Herd header, so a coachmark
  // anchor is reliably mounted — point at it via targetId + use:coachTarget.
  id: "done-lens",
  sinceVersion: "1.30.0",
  titleKey: "feat_done_lens_title",
  bodyKey: "feat_done_lens_body",
  targetId: "done-lens",
} satisfies FeatureAnnouncement;

export default entry;
