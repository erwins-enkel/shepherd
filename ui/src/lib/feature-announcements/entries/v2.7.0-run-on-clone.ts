import type { FeatureAnnouncement } from "../../feature-announcements";

// No targetId: the Run on choice only renders while a machine is connected.
export default {
  id: "run-on-clone",
  sinceVersion: "2.7.0",
  titleKey: "feat_run_on_clone_title",
  bodyKey: "feat_run_on_clone_body",
} satisfies FeatureAnnouncement;
