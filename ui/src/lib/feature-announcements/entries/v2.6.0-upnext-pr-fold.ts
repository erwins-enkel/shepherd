import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // The "Pull requests" super-header in Up Next folds the whole PR block; the fold is remembered.
  id: "upnext-pr-fold",
  sinceVersion: "2.6.0",
  titleKey: "feat_upnext_pr_fold_title",
  bodyKey: "feat_upnext_pr_fold_body",
} satisfies FeatureAnnouncement;
