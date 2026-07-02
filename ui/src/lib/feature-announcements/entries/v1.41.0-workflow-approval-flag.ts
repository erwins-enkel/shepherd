import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // PRs tab now flags a PR whose GitHub Actions workflow is awaiting manual approval
  // to run (the action_required flavor). No targetId — the chip renders only on
  // affected rows, so there's no stable anchor to coach against.
  // v1.40.0 latest released → 1.41.0.
  id: "workflow-approval-flag",
  sinceVersion: "1.41.0",
  titleKey: "feat_workflow_approval_flag_title",
  bodyKey: "feat_workflow_approval_flag_body",
} satisfies FeatureAnnouncement;

export default entry;
