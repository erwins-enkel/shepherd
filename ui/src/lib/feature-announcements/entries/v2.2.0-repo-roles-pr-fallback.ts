import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // No targetId, like `repo-roles`: the roles controls live in the automation popover,
  // closed by default, so a coachmark anchor would rarely be mounted.
  id: "repo-roles-pr-fallback",
  sinceVersion: "2.2.0",
  titleKey: "feat_repo_roles_pr_title",
  bodyKey: "feat_repo_roles_pr_body",
} satisfies FeatureAnnouncement;
