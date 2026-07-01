import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the nudge is a timed bottom-left card that only appears after a
  // few days of use, not a persistent chrome element — surface via the What's-New
  // drawer only.
  id: "github-star",
  sinceVersion: "1.20.0",
  titleKey: "feat_star_title",
  bodyKey: "feat_star_body",
} satisfies FeatureAnnouncement;

export default entry;
