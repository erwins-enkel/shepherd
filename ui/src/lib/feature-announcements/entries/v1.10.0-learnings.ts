import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: Learnings was retired (#3139), so its automation-pill coachmark anchor is gone.
  // Kept as history in the What's-New drawer.
  id: "learnings",
  sinceVersion: "1.10.0",
  titleKey: "feat_learnings_title",
  bodyKey: "feat_learnings_body",
} satisfies FeatureAnnouncement;

export default entry;
