import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // targetId "session-recap" anchors the coachmark on the live SessionRecap card.
  // Extends Phase 1 visual recaps with six new card types: code, annotated-code,
  // data-model, api-endpoint, table, checklist. 1.33.0 is the latest released tag,
  // so this ships in 1.34.0.
  id: "visual-recap-cards",
  sinceVersion: "1.34.0",
  titleKey: "feat_visual_recap_cards_title",
  bodyKey: "feat_visual_recap_cards_body",
  targetId: "session-recap",
} satisfies FeatureAnnouncement;

export default entry;
