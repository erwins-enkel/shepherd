import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Issue steers sit beside Start in the Up Next preview (as on a backlog issue); the ones
  // that don't fit the row fold into a ▾ beside Start.
  id: "up-next-preview-steers",
  sinceVersion: "2.1.0",
  titleKey: "feat_upnext_preview_steers_title",
  bodyKey: "feat_upnext_preview_steers_body",
  targetId: "up-next-lens",
} satisfies FeatureAnnouncement;

export default entry;
