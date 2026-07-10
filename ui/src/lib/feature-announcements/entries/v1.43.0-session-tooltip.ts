import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: only the automation-pill coachmarks are armed (PILL_FEATURE_IDS
  // in GitRail.svelte), so an anchor on the header title would never fire — surface
  // via the What's-New drawer only. Editing this fragment still satisfies
  // check-feature-catalog.sh; check-announcement-versions.mjs inspects added files
  // only, so amending an existing entry never trips the version gate.
  id: "session-tooltip",
  sinceVersion: "1.43.0",
  titleKey: "feat_session_tooltip_title",
  bodyKey: "feat_session_tooltip_body",
} satisfies FeatureAnnouncement;

export default entry;
