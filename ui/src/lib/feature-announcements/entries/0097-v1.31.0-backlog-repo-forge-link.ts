import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the link is inline in the panel header (only rendered when a repo is
  // selected in the Backlog view), so a coachmark anchor would usually be unmounted —
  // surface via the What's-New drawer only. 1.30.0 is the latest released tag, so this
  // ships in 1.31.0: computeNewEntries only surfaces entries with sinceVersion > lastSeen.
  id: "backlog-repo-forge-link",
  sinceVersion: "1.31.0",
  titleKey: "feat_backlog_repo_link_title",
  bodyKey: "feat_backlog_repo_link_body",
} satisfies FeatureAnnouncement;

export default entry;
