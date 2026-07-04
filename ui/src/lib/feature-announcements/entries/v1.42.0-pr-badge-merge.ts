import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // The PR badge menu on session cards gains a Merge action: shown only when the
  // PR is actually mergeable (open, not draft, no conflicts, checks not failing),
  // armed with a two-tap confirm before it merges via the existing merge endpoint.
  id: "pr-badge-merge",
  sinceVersion: "1.42.0",
  titleKey: "feat_pr_badge_merge_title",
  bodyKey: "feat_pr_badge_merge_body",
} satisfies FeatureAnnouncement;

export default entry;
