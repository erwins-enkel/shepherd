import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the Complete badge only appears on a session autopilot has just finished,
  // so a coachmark anchor would rarely be mounted — surface via the What's-New drawer only.
  id: "autopilot-complete",
  sinceVersion: "1.17.0",
  titleKey: "feat_autopilot_complete_title",
  bodyKey: "feat_autopilot_complete_body",
} satisfies FeatureAnnouncement;

export default entry;
