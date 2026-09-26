import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // #1841: a conflicting epic landing PR gets a conflict-rework agent (auto under Auto-Drain, or
  // the "Resolve conflicts" button) that rebases + force-pushes the integration branch.
  id: "landing-conflict-rework",
  sinceVersion: "1.48.0",
  titleKey: "feat_landing_conflict_rework_title",
  bodyKey: "feat_landing_conflict_rework_body",
} satisfies FeatureAnnouncement;

export default entry;
