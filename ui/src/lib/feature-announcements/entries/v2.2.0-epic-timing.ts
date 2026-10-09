import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // coachTarget "epic-timing" sits on the first epic group's EPIC badge only — coachTargets
  // keys one node per id, so the list-repeated badges can't all claim it.
  id: "epic-timing",
  sinceVersion: "2.2.0",
  titleKey: "feat_epic_timing_title",
  bodyKey: "feat_epic_timing_body",
  targetId: "epic-timing",
} satisfies FeatureAnnouncement;
