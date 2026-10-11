import type { FeatureAnnouncement } from "../../feature-announcements";

// No targetId: the Run on choice only renders while a machine is connected.
export default {
  id: "run-on-machine",
  sinceVersion: "2.2.0",
  titleKey: "feat_run_on_machine_title",
  bodyKey: "feat_run_on_machine_body",
} satisfies FeatureAnnouncement;
