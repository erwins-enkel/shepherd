import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the triage band, over-budget meter, and header filters all render conditionally
  // (only when a repo needs attention), so there's no stable anchor element; surface via the
  // What's-New drawer only. 1.33.0 is the latest released tag, so this ships in 1.34.0.
  id: "learnings-triage-layer",
  sinceVersion: "1.34.0",
  titleKey: "feat_learnings_triage_title",
  bodyKey: "feat_learnings_triage_body",
} satisfies FeatureAnnouncement;

export default entry;
