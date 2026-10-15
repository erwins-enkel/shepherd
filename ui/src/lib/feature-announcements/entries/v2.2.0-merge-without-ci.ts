import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // #3104: a GitHub repo with zero workflows no longer auto-merges unchecked PRs. No targetId:
  // the opt-in toggle only mounts inside a repo's automation settings.
  id: "merge-without-ci",
  sinceVersion: "2.2.0",
  titleKey: "feat_merge_without_ci_title",
  bodyKey: "feat_merge_without_ci_body",
} satisfies FeatureAnnouncement;

export default entry;
