import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the switch lives inside the Settings dialog's Device tab, which only
  // mounts once the operator opens it, so a coachmark anchor would never resolve.
  id: "hide-info-tips",
  sinceVersion: "1.44.0",
  titleKey: "feat_hide_info_tips_title",
  bodyKey: "feat_hide_info_tips_body",
} satisfies FeatureAnnouncement;

export default entry;
