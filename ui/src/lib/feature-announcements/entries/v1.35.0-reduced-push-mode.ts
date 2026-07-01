import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Reduced notifications mode (#896): a global switch (Settings → Device) that
  // silences every push except a session sitting in the "ready" filter for 5s,
  // keeping only usage/cost alerts. The control lives behind the settings gear +
  // Device tab → no always-visible anchor, so What's-New only, no coachmark.
  // v1.34.0 is the latest released tag → ships in 1.35.0.
  id: "reduced-push-mode",
  sinceVersion: "1.35.0",
  titleKey: "feat_reduced_push_title",
  bodyKey: "feat_reduced_push_body",
} satisfies FeatureAnnouncement;

export default entry;
