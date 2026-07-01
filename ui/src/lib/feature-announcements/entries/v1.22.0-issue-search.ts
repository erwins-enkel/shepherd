import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the search field only mounts once a repo with open issues is
  // selected in the Backlog view, so a coachmark anchor would usually be
  // unmounted — surface via the What's-New drawer only.
  id: "issue-search",
  sinceVersion: "1.22.0",
  titleKey: "feat_issue_search_title",
  bodyKey: "feat_issue_search_body",
} satisfies FeatureAnnouncement;

export default entry;
