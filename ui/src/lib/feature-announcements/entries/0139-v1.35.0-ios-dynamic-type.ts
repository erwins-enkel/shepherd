import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // The iOS home-screen PWA now honors the system Text Size (Dynamic Type)
  // setting — the whole type scale scales from the Control Center / Settings
  // slider. No anchor element, so no coachmark. v1.34.0 is the latest released
  // tag → ships in 1.35.0.
  id: "ios-dynamic-type",
  sinceVersion: "1.35.0",
  titleKey: "feat_ios_text_size_title",
  bodyKey: "feat_ios_text_size_body",
} satisfies FeatureAnnouncement;

export default entry;
