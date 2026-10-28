import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // Merge ▾ in Up Next: pick squash, rebase or a merge commit for one PR, from the methods the
  // repo allows (UpNextPrPreview / UpNextPrRowStatus → MergeMethodMenu).
  id: "merge-method-menu",
  sinceVersion: "2.6.0",
  titleKey: "feat_merge_method_menu_title",
  bodyKey: "feat_merge_method_menu_body",
} satisfies FeatureAnnouncement;
