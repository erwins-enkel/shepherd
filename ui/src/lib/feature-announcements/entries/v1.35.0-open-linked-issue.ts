import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Open linked issue (#876): GitRail shows "Issue #N ↗" link for sessions spawned
  // from a backlog issue, letting the user jump straight to the issue on GitHub/Gitea.
  id: "open-linked-issue",
  sinceVersion: "1.35.0",
  titleKey: "feat_open_linked_issue_title",
  bodyKey: "feat_open_linked_issue_body",
} satisfies FeatureAnnouncement;

export default entry;
