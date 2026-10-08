import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Ready lens (and the ready push / autopilot) now waits while a resting session's agent
  // still runs a non-server background shell (e.g. `git push` in its pre-push gates).
  // Behavioral, no new control → What's-New drawer only.
  id: "ready-lens-background-shells",
  sinceVersion: "2.2.0",
  titleKey: "feat_ready_lens_background_shells_title",
  bodyKey: "feat_ready_lens_background_shells_body",
} satisfies FeatureAnnouncement;

export default entry;
