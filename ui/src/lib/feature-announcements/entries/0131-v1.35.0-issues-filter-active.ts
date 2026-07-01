import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // "Hide in progress" issue filter — drops shepherd:active issues on both the
  // Backlog and New Task issue lists. The filter now lives in the Filters menu;
  // the chip/targetId was removed. v1.34.0 is the latest released tag → 1.35.0.
  id: "issues-filter-active",
  sinceVersion: "1.35.0",
  titleKey: "feat_issues_filter_active_title",
  bodyKey: "feat_issues_filter_active_body",
} satisfies FeatureAnnouncement;

export default entry;
