import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Done lens: right-click / long-press a finished session's row → Bring back. No targetId: the
  // rows only mount when the Done lens is open.
  id: "done-row-bring-back",
  sinceVersion: "2.1.0",
  titleKey: "feat_done_row_bring_back_title",
  bodyKey: "feat_done_row_bring_back_body",
} satisfies FeatureAnnouncement;

export default entry;
