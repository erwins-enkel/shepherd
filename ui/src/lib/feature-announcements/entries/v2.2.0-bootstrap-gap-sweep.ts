import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Bootstrap P3 gap sweep (#3110). No targetId: the mode lives inside the New Task dialog.
  id: "bootstrap-gap-sweep",
  sinceVersion: "2.2.0",
  titleKey: "feat_bootstrap_gap_sweep_title",
  bodyKey: "feat_bootstrap_gap_sweep_body",
} satisfies FeatureAnnouncement;

export default entry;
