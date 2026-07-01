import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Integrated-epics band now shows a "Land epic" CTA when the landing PR is ready —
  // one-click merge from the app, no GitHub context-switch needed. No targetId — the
  // band only mounts when completed epics exist; surface via the What's-New drawer only.
  // v1.36.0 → ships in 1.37.0.
  id: "land-epic-cta",
  sinceVersion: "1.37.0",
  titleKey: "feat_land_epic_title",
  bodyKey: "feat_land_epic_body",
} satisfies FeatureAnnouncement;

export default entry;
