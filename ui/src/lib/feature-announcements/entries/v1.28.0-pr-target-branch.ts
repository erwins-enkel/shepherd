import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the chip is per-row/dynamic (only on PRs targeting a non-default
  // branch) — there's no single stable anchor for a coachmark. Surface via the
  // What's-New drawer only.
  id: "pr-target-branch",
  sinceVersion: "1.28.0",
  titleKey: "feat_pr_target_branch_title",
  bodyKey: "feat_pr_target_branch_body",
} satisfies FeatureAnnouncement;

export default entry;
