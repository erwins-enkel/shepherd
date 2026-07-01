import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the Diagnostics tab lives inside the Settings modal (closed by
  // default), so a coachmark anchor would rarely be mounted — What's-New drawer only.
  // 1.29.0 is the latest released tag, so this ships in 1.30.0.
  id: "pwa-install-diagnostic",
  sinceVersion: "1.30.0",
  titleKey: "feat_pwa_install_title",
  bodyKey: "feat_pwa_install_body",
} satisfies FeatureAnnouncement;

export default entry;
