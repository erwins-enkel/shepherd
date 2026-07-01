import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the filter toggle only renders when flagged rules exist, so there's no
  // stable anchor; surface via the What's-New drawer only. 1.33.0 is the latest released
  // tag, so this ships in 1.34.0.
  id: "optimize-not-working-learnings",
  sinceVersion: "1.34.0",
  titleKey: "feat_optimize_learnings_title",
  bodyKey: "feat_optimize_learnings_body",
} satisfies FeatureAnnouncement;

export default entry;
