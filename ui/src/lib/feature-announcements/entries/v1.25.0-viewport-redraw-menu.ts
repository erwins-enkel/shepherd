import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: only the automation-pill coachmarks are armed (PILL_FEATURE_IDS
  // in GitRail.svelte), so an anchor on the header button would never fire —
  // surface via the What's-New drawer only. v1.24.0 is already tagged, so this
  // ships in the next release (1.25.0).
  id: "viewport-redraw-menu",
  sinceVersion: "1.25.0",
  titleKey: "feat_redraw_menu_title",
  bodyKey: "feat_redraw_menu_body",
} satisfies FeatureAnnouncement;

export default entry;
