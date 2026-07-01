import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Learnings drawer repo group headers now carry the project emoji (or the ▣
  // marker) before the repo name, matching the session-card label so it's clear
  // at a glance which repo each card concerns. Lives in the closed-by-default
  // drawer → What's-New only, no coachmark target.
  id: "learnings-repo-glyph",
  sinceVersion: "1.35.0",
  titleKey: "feat_learnings_repo_glyph_title",
  bodyKey: "feat_learnings_repo_glyph_body",
} satisfies FeatureAnnouncement;

export default entry;
