import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // The Activity tab now renders a deterministic live visual feed (file-tree from the
  // diff + a kind-sectioned tool stream) and graduates to the full visual recap once
  // the session settles. v1.34.0 is the latest released tag → ships in 1.35.0.
  id: "activity-visual-feed",
  sinceVersion: "1.35.0",
  titleKey: "feat_activity_visual_feed_title",
  bodyKey: "feat_activity_visual_feed_body",
  targetId: "activity-tab",
} satisfies FeatureAnnouncement;

export default entry;
