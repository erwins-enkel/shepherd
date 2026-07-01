import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId — the collapse chevron only mounts on unfolded-fold / touch-wide
  // layouts, so a coachmark anchor would rarely exist — surface via the What's-New
  // drawer only. v1.24.0 is already tagged, so this ships in the next release (1.25.0).
  id: "sidebar-collapse",
  sinceVersion: "1.25.0",
  titleKey: "feat_sidebar_collapse_title",
  bodyKey: "feat_sidebar_collapse_body",
} satisfies FeatureAnnouncement;

export default entry;
