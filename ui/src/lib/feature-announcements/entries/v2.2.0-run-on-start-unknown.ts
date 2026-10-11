import type { FeatureAnnouncement } from "../../feature-announcements";

// No targetId: the row only renders while a task's start on another machine is unknown.
export default {
  id: "run-on-start-unknown",
  sinceVersion: "2.2.0",
  titleKey: "feat_run_on_start_unknown_title",
  bodyKey: "feat_run_on_start_unknown_body",
} satisfies FeatureAnnouncement;
