import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the repo switcher only renders with live repo chips, so there
  // is no stable always-mounted coachmark anchor. Surface via What's-New only.
  id: "repo-chip-add-filter",
  sinceVersion: "1.43.0",
  titleKey: "feat_repo_chip_add_filter_title",
  bodyKey: "feat_repo_chip_add_filter_body",
} satisfies FeatureAnnouncement;

export default entry;
