import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the roles controls live in the automation popover, closed by
  // default, so a coachmark anchor would rarely be mounted — surface via the
  // What's-New drawer only.
  id: "repo-roles",
  sinceVersion: "1.20.0",
  titleKey: "feat_repo_roles_title",
  bodyKey: "feat_repo_roles_body",
} satisfies FeatureAnnouncement;

export default entry;
