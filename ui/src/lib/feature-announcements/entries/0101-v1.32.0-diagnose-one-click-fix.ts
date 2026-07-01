import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the Fix button lives in the Settings → Diagnostics tab (modal closed
  // by default), so a coachmark anchor would rarely be mounted — surface via the
  // What's-New drawer only (same as the prior "diagnostics"/"pwa-install-diagnostic"
  // entries). 1.31.0 is the latest released tag, so this ships in 1.32.0.
  id: "diagnose-one-click-fix",
  sinceVersion: "1.32.0",
  titleKey: "feat_diagnose_fix_title",
  bodyKey: "feat_diagnose_fix_body",
} satisfies FeatureAnnouncement;

export default entry;
