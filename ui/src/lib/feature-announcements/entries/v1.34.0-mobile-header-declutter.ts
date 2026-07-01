import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // targetId "mobile-seg-ctrl" anchors the coachmark on the segmented control
  // wrapper in the Herd header (flow/mobile mode). 1.33.0 is the latest released
  // tag, so this ships in 1.34.0.
  id: "mobile-header-declutter",
  sinceVersion: "1.34.0",
  titleKey: "feat_mobile_header_title",
  bodyKey: "feat_mobile_header_body",
  targetId: "mobile-seg-ctrl",
} satisfies FeatureAnnouncement;

export default entry;
