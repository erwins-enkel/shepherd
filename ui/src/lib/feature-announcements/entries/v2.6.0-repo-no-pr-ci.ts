import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // #3305: a repo whose PRs auto-merge holds for lack of PR CI is flagged on the repo itself —
  // rail chip, Repos tile, Automation tab — instead of as a row in Settings → Diagnostics.
  id: "repo-no-pr-ci",
  sinceVersion: "2.6.0",
  titleKey: "feat_repo_no_pr_ci_title",
  bodyKey: "feat_repo_no_pr_ci_body",
} satisfies FeatureAnnouncement;

export default entry;
