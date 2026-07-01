import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the control lives in the Settings modal, closed by default, so a
  // coachmark anchor would rarely be mounted — surface via the What's-New drawer only.
  id: "review-cycles",
  sinceVersion: "1.20.0",
  titleKey: "feat_review_cycles_title",
  bodyKey: "feat_review_cycles_body",
} satisfies FeatureAnnouncement;

export default entry;
