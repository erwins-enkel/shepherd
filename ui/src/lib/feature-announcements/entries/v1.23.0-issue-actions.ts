import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the issue-action buttons live on backlog issue rows (rendered only
  // when the backlog is open) and the editor inside Settings — both usually unmounted,
  // so surface via the What's-New drawer only. v1.22.0 is already tagged, so this
  // ships in the next release (1.23.0): computeNewEntries only surfaces entries with
  // sinceVersion > lastSeen.
  id: "issue-actions",
  sinceVersion: "1.23.0",
  titleKey: "feat_issue_actions_title",
  bodyKey: "feat_issue_actions_body",
} satisfies FeatureAnnouncement;

export default entry;
