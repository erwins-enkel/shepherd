import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // targetId "task-autopilot" anchors the coachmark on the Autopilot row in the New
  // Task dialog, where the new "i" tooltips and the repo-default badge live. 1.31.0
  // is the latest released tag, so this ships in 1.32.0.
  id: "newtask-option-infotips",
  sinceVersion: "1.32.0",
  titleKey: "feat_newtask_infotips_title",
  bodyKey: "feat_newtask_infotips_body",
  targetId: "task-autopilot",
} satisfies FeatureAnnouncement;

export default entry;
