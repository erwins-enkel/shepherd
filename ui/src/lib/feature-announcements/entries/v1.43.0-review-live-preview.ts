import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the only <Coachmark> host (GitRail) arms exclusively from PILL_FEATURE_IDS
  // (critic / auto-address / learnings), so an anchor on the review-in-flight banner would never
  // fire — it would be a dead coachmark target. This feature surfaces via the What's-New drawer.
  id: "review-live-preview",
  sinceVersion: "1.43.0",
  titleKey: "feat_review_live_preview_title",
  bodyKey: "feat_review_live_preview_body",
} satisfies FeatureAnnouncement;

export default entry;
