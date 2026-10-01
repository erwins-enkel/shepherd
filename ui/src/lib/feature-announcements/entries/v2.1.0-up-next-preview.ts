import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // A clicked Up Next title opens the issue in the main area (labels, description, Start)
  // instead of leaving for GitHub; rows carry every label, bands fold, the start bar sticks.
  id: "up-next-preview",
  sinceVersion: "2.1.0",
  titleKey: "feat_upnext_preview_title",
  bodyKey: "feat_upnext_preview_body",
  targetId: "up-next-lens",
} satisfies FeatureAnnouncement;

export default entry;
