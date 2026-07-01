import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the Readiness tab only mounts once a project is selected
  // inside the Backlog overlay, so a coachmark anchor would rarely exist —
  // surface via the What's-New drawer only.
  id: "readiness-analyzer",
  sinceVersion: "1.18.0",
  titleKey: "feat_readiness_title",
  bodyKey: "feat_readiness_body",
} satisfies FeatureAnnouncement;

export default entry;
