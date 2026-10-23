import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Settings → Diagnostics lists each repo whose PRs auto-merge holds for lack of PR CI (#3305).
  // No targetId: the rows only mount inside Settings.
  id: "diagnostics-no-pr-ci",
  sinceVersion: "2.3.0",
  titleKey: "feat_diagnostics_no_pr_ci_title",
  bodyKey: "feat_diagnostics_no_pr_ci_body",
} satisfies FeatureAnnouncement;

export default entry;
