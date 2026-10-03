import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // A refused GitHub clone names both credentials (gh, which lists the repos, and git, which
  // clones them) and offers the fix right in the clone dialog — usually `gh auth setup-git`.
  id: "clone-access-diagnosis",
  sinceVersion: "2.1.0",
  titleKey: "feat_clone_access_title",
  bodyKey: "feat_clone_access_body",
} satisfies FeatureAnnouncement;

export default entry;
