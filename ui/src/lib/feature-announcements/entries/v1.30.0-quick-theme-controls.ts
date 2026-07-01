import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the controls live inside the gear menu (closed by default) and the
  // feature is mobile-only, so a desktop coachmark anchor would mislead — surface via
  // the What's-New drawer only. 1.29.0 is the latest released tag, so this ships in 1.30.0.
  id: "quick-theme-controls",
  sinceVersion: "1.30.0",
  titleKey: "feat_quick_theme_title",
  bodyKey: "feat_quick_theme_body",
} satisfies FeatureAnnouncement;

export default entry;
