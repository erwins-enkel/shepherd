import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the PR badge is per-card/dynamic and only exists once a session
  // has an open PR, so surface via the What's-New drawer only. Ships in 1.39.0.
  id: "pr-badge-menu",
  sinceVersion: "1.39.0",
  titleKey: "feat_pr_badge_menu_title",
  bodyKey: "feat_pr_badge_menu_body",
} satisfies FeatureAnnouncement;

export default entry;
