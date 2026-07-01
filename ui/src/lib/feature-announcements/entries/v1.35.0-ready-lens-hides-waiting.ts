import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Ready lens now hides sessions that aren't the operator's turn (handed off to a
  // foreign reviewer/merger, or mid-merge-train). The filter tab is always mounted,
  // but the change is behavioral rather than a new control → What's-New drawer only.
  id: "ready-lens-hides-waiting",
  sinceVersion: "1.35.0",
  titleKey: "feat_ready_lens_hides_waiting_title",
  bodyKey: "feat_ready_lens_hides_waiting_body",
} satisfies FeatureAnnouncement;

export default entry;
