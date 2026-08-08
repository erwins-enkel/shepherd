import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  id: "video-brief",
  sinceVersion: "1.47.0",
  titleKey: "feat_video_brief_title",
  bodyKey: "feat_video_brief_body",
  // No targetId: the row only exists while a screen recording is attached, so a coachmark would
  // have nothing to point at on the drawer's first view.
} satisfies FeatureAnnouncement;

export default entry;
