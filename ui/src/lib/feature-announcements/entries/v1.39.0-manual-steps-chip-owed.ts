import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // The "N manual step(s)" chip on a merged/eligible session row is now a link that opens the
  // Owed lens and scrolls to that session's steps (with a read-only frozen card when the record
  // is already cleared or the PR hasn't merged yet). No targetId — the chip is per-row and
  // conditionally rendered, so there's no stable coachmark anchor. Ships in 1.39.0.
  id: "manual-steps-chip-owed",
  sinceVersion: "1.39.0",
  titleKey: "feat_manual_steps_chip_title",
  bodyKey: "feat_manual_steps_chip_body",
} satisfies FeatureAnnouncement;

export default entry;
