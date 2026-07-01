import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Issue filters grouped into a single "Filters" menu (was a row of chips) on both
  // the Backlog and New Task issue lists. targetId "issue-filters" matches
  // use:coachTarget on the IssueFilterPopover trigger (Backlog). v1.34.0 latest → 1.35.0.
  id: "issue-filters-menu",
  sinceVersion: "1.35.0",
  titleKey: "feat_issue_filters_menu_title",
  bodyKey: "feat_issue_filters_menu_body",
  targetId: "issue-filters",
} satisfies FeatureAnnouncement;

export default entry;
