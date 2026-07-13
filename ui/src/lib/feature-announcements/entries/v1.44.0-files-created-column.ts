import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Files tab gains a Created column (birth time, mtime fallback) that's sortable alongside
  // Name. next-version reports 1.44.0, so this ships there.
  id: "files-created-column",
  sinceVersion: "1.44.0",
  titleKey: "feat_files_created_column_title",
  bodyKey: "feat_files_created_column_body",
  targetId: "files-tab",
} satisfies FeatureAnnouncement;

export default entry;
