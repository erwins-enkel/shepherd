import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // targetId "newproject-row" matches the use:coachTarget id on the "+ New project"
  // row in RepoSelect.svelte. 1.23.0 is already tagged, so this ships in 1.24.0:
  // computeNewEntries only surfaces entries with sinceVersion > lastSeen.
  id: "new-project-from-shepherd",
  sinceVersion: "1.24.0",
  titleKey: "feat_new_project_title",
  bodyKey: "feat_new_project_body",
  targetId: "newproject-row",
} satisfies FeatureAnnouncement;

export default entry;
