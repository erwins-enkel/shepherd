import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the multi-select controls live inside the PRs tab which is
  // only mounted when a repo is selected; coachmark anchor added in a later task.
  id: "backlog-pr-merge-train",
  // v1.19.0 is already tagged, so this feature ships in the next release (1.20.0).
  // computeNewEntries only surfaces entries with lastSeen < sinceVersion, so a
  // 1.19.0 entry would never reach users who already saw the 1.19.0 drawer.
  sinceVersion: "1.20.0",
  titleKey: "feat_backlog_pr_merge_train_title",
  bodyKey: "feat_backlog_pr_merge_train_body",
} satisfies FeatureAnnouncement;

export default entry;
