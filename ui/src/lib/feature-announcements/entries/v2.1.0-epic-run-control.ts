import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // The epic detail in Repos → Issues gains the run area (#2620): live state, Now → Next → After
  // and every epic action; the list marks the leading and the winding-down epic. No targetId:
  // the area only mounts once an epic is selected in the Repos dialog.
  id: "epic-run-control",
  sinceVersion: "2.1.0",
  titleKey: "feat_epic_run_control_title",
  bodyKey: "feat_epic_run_control_body",
} satisfies FeatureAnnouncement;

export default entry;
