import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // One entry for the whole epic-timing epic: the body names the EPIC badge's hover (#2938) and
  // the backlog epic detail's tiles, timeline and durations (#2939).
  // coachTarget "epic-timing" sits on the first epic group's EPIC badge only — coachTargets
  // keys one node per id, so the list-repeated badges can't all claim it.
  id: "epic-timing",
  sinceVersion: "2.2.0",
  titleKey: "feat_epic_timing_title",
  bodyKey: "feat_epic_timing_body",
  targetId: "epic-timing",
} satisfies FeatureAnnouncement;
