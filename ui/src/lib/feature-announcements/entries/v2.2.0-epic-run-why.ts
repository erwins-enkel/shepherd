import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // An epic that stopped leading says why in its run area: superseded by which epic (linked, with
  // its progress) or ended, when, and through which machine token. No targetId: the line only
  // shows on an epic that stopped.
  id: "epic-run-why",
  sinceVersion: "2.2.0",
  titleKey: "feat_epic_run_why_title",
  bodyKey: "feat_epic_run_why_body",
} satisfies FeatureAnnouncement;

export default entry;
