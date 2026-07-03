import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // First-run "Run this epic hands-off" explainer on the Epic panel: a current-vs-recommended
  // automation checklist + one-click "Apply hands-off defaults", plus a "Recommended for hands-off
  // epics →" hint on the automation pane and a docs guide. No targetId: GitRail (the only Coachmark
  // host) arms only PILL_FEATURE_IDS, so a coachmark can't point at the Epic panel — this surfaces
  // via the What's-New drawer only (same as AddRepoButton's entry).
  id: "hands-off-epics",
  sinceVersion: "1.42.0",
  titleKey: "feat_hands_off_epics_title",
  bodyKey: "feat_hands_off_epics_body",
} satisfies FeatureAnnouncement;

export default entry;
