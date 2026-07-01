import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the recent-repos group only mounts inside the open repo picker
  // dropdown in New Task, so a coachmark anchor would usually be unmounted —
  // surface via the What's-New drawer only.
  id: "recent-repos-pinned",
  sinceVersion: "1.21.0",
  titleKey: "feat_recent_repos_title",
  bodyKey: "feat_recent_repos_body",
} satisfies FeatureAnnouncement;

export default entry;
