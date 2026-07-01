import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the toggle lives on the Settings → Device tab (modal closed by
  // default), so a coachmark anchor would rarely be mounted — surface via the
  // What's-New drawer only. 1.27.0 is the latest released tag, so this ships in 1.28.0.
  id: "mobile-high-contrast",
  sinceVersion: "1.28.0",
  titleKey: "feat_mobile_contrast_title",
  bodyKey: "feat_mobile_contrast_body",
} satisfies FeatureAnnouncement;

export default entry;
