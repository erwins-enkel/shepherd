import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the control lives in a card's right-click / long-press context
  // menu, not a fixed anchor, so a coachmark anchor would rarely be mounted —
  // surface via the What's-New drawer only. Ships in 1.26.0 (1.25.0 just shipped).
  id: "relaunch-task",
  sinceVersion: "1.26.0",
  titleKey: "feat_relaunch_title",
  bodyKey: "feat_relaunch_body",
} satisfies FeatureAnnouncement;

export default entry;
