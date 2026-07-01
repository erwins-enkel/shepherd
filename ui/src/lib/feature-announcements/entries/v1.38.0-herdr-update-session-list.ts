import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // The herdr-update dialog now lists each running session the restart would
  // interrupt, and each row jumps straight to that session — so you can wrap
  // them up one by one before updating instead of trusting a bare count. No
  // targetId — the anchor only exists while the update dialog is open.
  id: "herdr-update-session-list",
  sinceVersion: "1.38.0",
  titleKey: "feat_herdr_update_session_list_title",
  bodyKey: "feat_herdr_update_session_list_body",
} satisfies FeatureAnnouncement;

export default entry;
