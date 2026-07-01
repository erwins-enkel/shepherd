import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // The clone dialog now lists every GitHub repo you can reach (your own account +
  // the orgs/teams you belong to) and clones the picked one directly. 1.32.0 is the
  // latest released tag, so this ships in 1.33.0.
  id: "clone-repo-picker",
  sinceVersion: "1.33.0",
  titleKey: "feat_clone_repo_picker_title",
  bodyKey: "feat_clone_repo_picker_body",
} satisfies FeatureAnnouncement;

export default entry;
