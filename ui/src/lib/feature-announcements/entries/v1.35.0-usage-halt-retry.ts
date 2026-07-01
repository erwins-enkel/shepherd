import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the ⟳ Retry button only renders in the SteerBar when usage-halted
  // sessions exist and usage has dropped back below the hold threshold, so a coachmark
  // anchor would rarely be mounted — surface via the What's-New drawer only.
  // v1.34.0 is the latest released tag → ships in 1.35.0.
  id: "usage-halt-retry",
  sinceVersion: "1.35.0",
  titleKey: "feat_usage_halt_retry_title",
  bodyKey: "feat_usage_halt_retry_body",
} satisfies FeatureAnnouncement;

export default entry;
