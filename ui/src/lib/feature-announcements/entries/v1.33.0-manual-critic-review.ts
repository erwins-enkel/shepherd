import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // targetId "manual-critic-review" anchors the coachmark on the Review/Re-review
  // button on the PR rail (GitRail), shown for open PRs with green CI + critic on.
  // 1.32.0 is the latest released tag, so this ships in 1.33.0.
  id: "manual-critic-review",
  sinceVersion: "1.33.0",
  titleKey: "feat_manual_critic_review_title",
  bodyKey: "feat_manual_critic_review_body",
  targetId: "manual-critic-review",
} satisfies FeatureAnnouncement;

export default entry;
