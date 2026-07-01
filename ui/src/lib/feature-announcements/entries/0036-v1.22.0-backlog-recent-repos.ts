import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the backlog repo list only mounts on the Backlog view (not the
  // default dashboard), so a coachmark anchor would usually be unmounted —
  // surface via the What's-New drawer only.
  id: "backlog-recent-repos",
  sinceVersion: "1.22.0",
  titleKey: "feat_backlog_recent_repos_title",
  bodyKey: "feat_backlog_recent_repos_body",
} satisfies FeatureAnnouncement;

export default entry;
