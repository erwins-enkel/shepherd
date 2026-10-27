import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // A Dependabot PR whose merge failed in Up Next swaps its Merge button for "Dependabot rebase".
  id: "upnext-dep-rebase",
  sinceVersion: "2.6.0",
  titleKey: "feat_upnext_dep_rebase_title",
  bodyKey: "feat_upnext_dep_rebase_body",
} satisfies FeatureAnnouncement;
