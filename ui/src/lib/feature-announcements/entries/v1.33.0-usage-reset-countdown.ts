import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the countdown surfaces in the hover tooltip and hover/tap popovers
  // of the TopBar usage gauges; there is no single persistent anchor element to
  // point a coachmark at. Surface via the What's-New drawer only. 1.32.0 is the
  // latest released tag, so this ships in 1.33.0.
  id: "usage-reset-countdown",
  sinceVersion: "1.33.0",
  titleKey: "feat_usage_reset_countdown_title",
  bodyKey: "feat_usage_reset_countdown_body",
} satisfies FeatureAnnouncement;

export default entry;
