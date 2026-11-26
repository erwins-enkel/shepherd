import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Herd rail Group: Stage | Repo switch (#4228) with per-repo status counts, plus the new global
  // Merge status. The coachmark points at the switch in the group bar under the lens strip.
  id: "herd-repo-layout",
  sinceVersion: "2.10.0",
  titleKey: "feat_herd_repo_layout_title",
  bodyKey: "feat_herd_repo_layout_body",
  targetId: "herd-repo-layout",
} satisfies FeatureAnnouncement;

export default entry;
