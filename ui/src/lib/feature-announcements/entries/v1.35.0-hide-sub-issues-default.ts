import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Hide native sub-issues by default on both the Backlog and New Task issue lists,
  // nudging an epic drain from the parent. The filter now lives in the Filters menu;
  // the chip/targetId was removed. v1.34.0 is the latest released tag → 1.35.0.
  id: "hide-sub-issues-default",
  sinceVersion: "1.35.0",
  titleKey: "feat_issues_filter_subissues_title",
  bodyKey: "feat_issues_filter_subissues_body",
} satisfies FeatureAnnouncement;

export default entry;
