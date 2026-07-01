import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: plan diagrams are per-plan (zero or many instances, only while the
  // plan panel is open), so there's no single stable coachmark anchor — surface via
  // the What's-New drawer only. 1.37.0 is the latest released tag, so this ships in 1.38.0.
  id: "plan-diagram-lightbox",
  sinceVersion: "1.38.0",
  titleKey: "feat_diagram_lightbox_title",
  bodyKey: "feat_diagram_lightbox_body",
} satisfies FeatureAnnouncement;

export default entry;
