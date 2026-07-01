import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Cross-repo recurrence (#843): rules that recur across many repos are surfaced as a
  // suggestion to promote one to a user-global CLAUDE.md. v1.34.0 latest released → 1.35.0.
  id: "learnings-cross-repo-recurrence",
  sinceVersion: "1.35.0",
  titleKey: "feat_learnings_recur_title",
  bodyKey: "feat_learnings_recur_body",
} satisfies FeatureAnnouncement;

export default entry;
