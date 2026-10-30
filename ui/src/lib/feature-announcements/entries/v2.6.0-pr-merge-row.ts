import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // The merge row above the steer bar (#3540): an open PR's state, prerequisites and its one
  // Merge; #3541 adds the next step in the same slot (fix CI, rebase, decommission).
  // Anchored to that main button (PrActionRow).
  id: "pr-merge-row",
  sinceVersion: "2.6.0",
  titleKey: "feat_pr_merge_row_title",
  bodyKey: "feat_pr_merge_row_body",
  targetId: "pr-merge-row",
} satisfies FeatureAnnouncement;
