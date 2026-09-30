import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // #1841: a running epic's integration branch is rebased onto the default branch whenever no
  // child is in flight, and a landing conflict left unresolved for hours is flagged + re-pushed.
  id: "epic-cadence-rebase",
  sinceVersion: "2.1.0",
  titleKey: "feat_epic_cadence_rebase_title",
  bodyKey: "feat_epic_cadence_rebase_body",
} satisfies FeatureAnnouncement;

export default entry;
