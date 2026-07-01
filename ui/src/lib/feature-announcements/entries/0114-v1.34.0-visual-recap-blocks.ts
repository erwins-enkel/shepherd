import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // targetId "session-recap" anchors the coachmark on the live SessionRecap card
  // (use:coachTarget={"session-recap"} in SessionRecap.svelte). 1.33.0 is the latest
  // released tag, so this ships in 1.34.0.
  id: "visual-recap-blocks",
  sinceVersion: "1.34.0",
  titleKey: "feat_visual_recap_title",
  bodyKey: "feat_visual_recap_body",
  targetId: "session-recap",
} satisfies FeatureAnnouncement;

export default entry;
