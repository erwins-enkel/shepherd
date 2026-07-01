import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the Repos control lives in the Settings modal → Saved steers (closed by
  // default), so a coachmark anchor would rarely be mounted — What's-New drawer only.
  id: "steer-repo-binding",
  sinceVersion: "1.39.0",
  titleKey: "feat_steer_repo_binding_title",
  bodyKey: "feat_steer_repo_binding_body",
} satisfies FeatureAnnouncement;

export default entry;
