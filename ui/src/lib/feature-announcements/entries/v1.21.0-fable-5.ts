import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the model picker lives in the New Task dialog (closed by default).
  // Beyond this drawer line, an upgrading user also gets the one-time FableArrival
  // celebration overlay — see FABLE_FEATURE_ID + FableArrival.svelte.
  // v1.20.0 is already tagged, so this ships in the next release (1.21.0):
  // computeNewEntries only surfaces entries with sinceVersion > lastSeen.
  id: "fable-5",
  sinceVersion: "1.21.0",
  titleKey: "feat_fable_title",
  bodyKey: "feat_fable_body",
} satisfies FeatureAnnouncement;

export default entry;
