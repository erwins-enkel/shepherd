import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // targetId "fork-row" anchors the coachmark on the "Fork a GitHub repo" trigger
  // in the repo picker (RepoSelect). 1.30.0 is the latest released tag, so this
  // ships in 1.31.0.
  id: "fork-repo",
  sinceVersion: "1.31.0",
  titleKey: "feat_fork_repo_title",
  bodyKey: "feat_fork_repo_body",
  targetId: "fork-row",
} satisfies FeatureAnnouncement;

export default entry;
