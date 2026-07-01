import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: several controls changed (▶ dev-server start, AP/✓ pips, status
  // glyph); no single persistent anchor — surface via the What's-New drawer only.
  id: "slim-viewport-header",
  sinceVersion: "1.23.0",
  titleKey: "feat_slim_header_title",
  bodyKey: "feat_slim_header_body",
} satisfies FeatureAnnouncement;

export default entry;
