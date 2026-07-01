import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Anchor lives on the DESKTOP tallies container only — the mobile compact
  // tallies are a mutually-exclusive DOM branch and coachTargets keys one node
  // per id, so on phones the coachmark simply has no anchor and the feature
  // surfaces via the What's-New drawer alone.
  // v1.21.0 is already tagged, so this ships in the next release (1.22.0).
  id: "tally-status-filter",
  sinceVersion: "1.22.0",
  titleKey: "feat_tally_filter_title",
  bodyKey: "feat_tally_filter_body",
  targetId: "tally-filter",
} satisfies FeatureAnnouncement;

export default entry;
