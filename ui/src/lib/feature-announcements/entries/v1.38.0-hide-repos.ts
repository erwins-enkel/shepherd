import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Repos you don't care about can be hidden from the Backlog repos panel (hover a
  // row → eye-off; a "Hidden · N" chip reveals + unhides). List-only — sessions,
  // drain and totals are untouched. No targetId — the eye control + Hidden chip are
  // conditional (hover-only / only when ≥1 repo is hidden), so there's no always-present
  // anchor; surface via the What's-New drawer only. Ships in 1.38.0 (1.37.0 is latest tag).
  id: "hide-repos",
  sinceVersion: "1.38.0",
  titleKey: "feat_hide_repos_title",
  bodyKey: "feat_hide_repos_body",
} satisfies FeatureAnnouncement;

export default entry;
