import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the glyph sits on rows inside the Repos overlay, which is
  // closed when the What's-New drawer opens — no anchor to point a coachmark at.
  id: "backlog-repo-icon",
  sinceVersion: "1.47.0",
  titleKey: "feat_backlog_repo_icon_title",
  bodyKey: "feat_backlog_repo_icon_body",
} satisfies FeatureAnnouncement;

export default entry;
