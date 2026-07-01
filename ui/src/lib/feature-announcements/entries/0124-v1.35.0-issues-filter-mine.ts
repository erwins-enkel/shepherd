import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // The filter chips (mine & unassigned, hide in progress, hide sub-issues) are now
  // grouped into a single "Filters" menu on both the Backlog and New Task issue lists.
  // The chip/targetId was removed; coachmark now lives on the IssueFilterPopover trigger.
  id: "issues-filter-mine",
  sinceVersion: "1.35.0",
  titleKey: "feat_issues_filter_mine_title",
  bodyKey: "feat_issues_filter_mine_body",
} satisfies FeatureAnnouncement;

export default entry;
