import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the toggle only mounts on the steer bar of a focused/selected
  // session, and there can be several steer bars in the DOM at once, so a single
  // coachmark anchor would be wrong — surface via the What's-New drawer only.
  // v1.23.0 is already tagged, so this ships in the next release (1.24.0):
  // computeNewEntries only surfaces entries with sinceVersion > lastSeen.
  id: "steer-labels-toggle",
  sinceVersion: "1.24.0",
  titleKey: "feat_steer_labels_title",
  bodyKey: "feat_steer_labels_body",
} satisfies FeatureAnnouncement;

export default entry;
