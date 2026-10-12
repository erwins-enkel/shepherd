import type { FeatureAnnouncement } from "../../feature-announcements";

// No targetId: the row only renders while a task waits for its machine.
export default {
  id: "run-on-waiting",
  sinceVersion: "2.2.0",
  titleKey: "feat_run_on_waiting_title",
  bodyKey: "feat_run_on_waiting_body",
} satisfies FeatureAnnouncement;
