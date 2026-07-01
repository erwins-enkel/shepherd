import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Epic #1071: auto-rebase for landing PRs. When paused (conflict/cap/driver), a warn chip on
  // the integrated-epics band row surfaces the reason and hands off to the operator. Ships in 1.37.0.
  id: "auto-rebase-landing-prs",
  sinceVersion: "1.37.0",
  titleKey: "feat_auto_rebase_landing_prs_title",
  bodyKey: "feat_auto_rebase_landing_prs_body",
  targetId: "rebase-paused-chip",
} satisfies FeatureAnnouncement;

export default entry;
