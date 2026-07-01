import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Read-only scratchpad file browser (#1164): a Files tab on a live session's viewport,
  // anchored via use:coachTarget={"files-tab"} in ViewportTabBar. 1.37.0 is the latest
  // released tag, so this ships in 1.38.0.
  id: "scratchpad-files",
  sinceVersion: "1.38.0",
  titleKey: "feat_scratchpad_files_title",
  bodyKey: "feat_scratchpad_files_body",
  targetId: "files-tab",
} satisfies FeatureAnnouncement;

export default entry;
