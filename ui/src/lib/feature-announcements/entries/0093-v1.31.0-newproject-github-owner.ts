import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the owner picker only mounts inside the New-project dialog (closed by
  // default) and only after the GitHub box is checked, so a coachmark anchor would
  // rarely be present — surface via the What's-New drawer only. 1.30.0 is the latest
  // released tag, so this ships in 1.31.0.
  id: "newproject-github-owner",
  sinceVersion: "1.31.0",
  titleKey: "feat_newproject_owner_title",
  bodyKey: "feat_newproject_owner_body",
} satisfies FeatureAnnouncement;

export default entry;
