import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // targetId "diagnostics" matches the use:coachTarget id on the TopBar health
  // pip, so the coachmark points at it. 1.27.0 is the latest released tag, so
  // this ships in 1.28.0: computeNewEntries only surfaces sinceVersion > lastSeen.
  id: "diagnostics",
  sinceVersion: "1.28.0",
  titleKey: "feat_diagnostics_title",
  bodyKey: "feat_diagnostics_body",
  targetId: "diagnostics",
} satisfies FeatureAnnouncement;

export default entry;
