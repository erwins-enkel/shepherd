import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // First-run "Run this epic hands-off" explainer on the Epic panel: a current-vs-recommended
  // automation checklist + one-click "Apply hands-off defaults", plus a "Recommended for hands-off
  // epics →" hint on the automation pane and a docs guide. targetId anchors the coachmark at the
  // Epic panel's Start button (coachTarget "epic-hands-off-intro").
  id: "hands-off-epics",
  sinceVersion: "1.42.0",
  titleKey: "feat_hands_off_epics_title",
  bodyKey: "feat_hands_off_epics_body",
  targetId: "epic-hands-off-intro",
} satisfies FeatureAnnouncement;

export default entry;
