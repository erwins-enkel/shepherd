import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Upload button is always mounted on the Files tab for any live session — a reliable
  // persistent anchor. use:coachTarget={"scratchpad-upload"} is on the Upload button
  // in FilesPanel.svelte. Ships in 1.39.0 (1.38.0 is the latest released tag).
  id: "scratchpad-upload",
  sinceVersion: "1.39.0",
  titleKey: "feat_scratchpad_upload_title",
  bodyKey: "feat_scratchpad_upload_body",
  targetId: "scratchpad-upload",
} satisfies FeatureAnnouncement;

export default entry;
