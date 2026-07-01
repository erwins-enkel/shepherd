import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the repo switcher only renders with live repo chips, so there
  // is no stable always-mounted coachmark anchor. Surface via What's-New only.
  id: "repo-chip-pin",
  sinceVersion: "1.39.0",
  titleKey: "feat_repo_chip_pin_title",
  bodyKey: "feat_repo_chip_pin_body",
} satisfies FeatureAnnouncement;

export default entry;
