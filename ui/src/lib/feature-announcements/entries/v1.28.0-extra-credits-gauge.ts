import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the CR credit gauge only mounts when paid extra usage is enabled
  // (limits.credits present), so a coachmark anchor would usually be absent —
  // surface via the What's-New drawer only. 1.27.0 is the latest released tag, so
  // this ships in 1.28.0: computeNewEntries only surfaces sinceVersion > lastSeen.
  id: "extra-credits-gauge",
  sinceVersion: "1.28.0",
  titleKey: "feat_extra_credits_title",
  bodyKey: "feat_extra_credits_body",
} satisfies FeatureAnnouncement;

export default entry;
