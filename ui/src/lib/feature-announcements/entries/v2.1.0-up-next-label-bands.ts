import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Up Next reads again in the narrow sidebar: label bands, full wrapping titles, and one
  // batch bar for starting. Anchored to the lens button like the original up-next entry.
  id: "up-next-label-bands",
  sinceVersion: "2.1.0",
  titleKey: "feat_upnext_bands_title",
  bodyKey: "feat_upnext_bands_body",
  targetId: "up-next-lens",
} satisfies FeatureAnnouncement;

export default entry;
