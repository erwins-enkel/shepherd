import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: this surfaces across the Readiness tab and Settings → House Stack.
  id: "readiness-swift",
  sinceVersion: "2.7.0",
  titleKey: "feat_readiness_swift_title",
  bodyKey: "feat_readiness_swift_body",
} satisfies FeatureAnnouncement;

export default entry;
