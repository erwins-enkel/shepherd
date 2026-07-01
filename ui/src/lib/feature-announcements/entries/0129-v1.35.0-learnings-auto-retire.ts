import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Effectiveness loop + safe auto-retire (#840). Surfaced in the Learnings drawer
  // (closed by default) → What's-New only, no coachmark target.
  id: "learnings-auto-retire",
  sinceVersion: "1.35.0",
  titleKey: "feat_learnings_auto_retire_title",
  bodyKey: "feat_learnings_auto_retire_body",
} satisfies FeatureAnnouncement;

export default entry;
