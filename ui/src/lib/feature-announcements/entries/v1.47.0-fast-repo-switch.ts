import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  id: "fast-repo-switch",
  sinceVersion: "1.47.0",
  titleKey: "feat_fast_repo_switch_title",
  bodyKey: "feat_fast_repo_switch_body",
  // No targetId: the only coachmark anchor in New Task ("nt-repo") is on the desktop
  // context row, and this change is mobile-only — it would never resolve where it counts.
} satisfies FeatureAnnouncement;

export default entry;
