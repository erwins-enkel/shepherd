import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the backlog repo list only mounts on the Backlog view (not the
  // default dashboard), so a coachmark anchor would usually be unmounted —
  // surface via the What's-New drawer only.
  id: "backlog-repo-search",
  sinceVersion: "1.26.0",
  titleKey: "feat_backlog_repo_search_title",
  bodyKey: "feat_backlog_repo_search_body",
} satisfies FeatureAnnouncement;

export default entry;
