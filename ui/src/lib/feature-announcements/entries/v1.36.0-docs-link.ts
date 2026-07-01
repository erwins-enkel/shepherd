import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Top-bar documentation link (#…): a standing docs entry next to the gear plus an
  // entry in the gear menu / mobile sheet, pointing at docs.shepherd.run. targetId
  // "docs-link" matches use:coachTarget on the standalone TopBar anchor (desktop).
  id: "docs-link",
  sinceVersion: "1.36.0",
  titleKey: "feat_docs_link_title",
  bodyKey: "feat_docs_link_body",
  targetId: "docs-link",
} satisfies FeatureAnnouncement;

export default entry;
