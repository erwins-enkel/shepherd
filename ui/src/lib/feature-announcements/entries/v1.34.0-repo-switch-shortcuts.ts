import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // targetId "nt-repo" anchors the coachmark on the New Task repo field
  // (use:coachTarget={"nt-repo"}). 1.33.0 is the latest released tag, so this
  // ships in 1.34.0.
  id: "repo-switch-shortcuts",
  sinceVersion: "1.34.0",
  titleKey: "feat_repo_shortcuts_title",
  bodyKey: "feat_repo_shortcuts_body",
  targetId: "nt-repo",
} satisfies FeatureAnnouncement;

export default entry;
