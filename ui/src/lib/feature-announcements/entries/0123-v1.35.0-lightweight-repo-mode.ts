import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // targetId "lightweight-repo" matches use:coachTarget on the lightweight toggle row
  // in AutomationPanel. v1.34.0 is the latest released tag → ships in 1.35.0.
  id: "lightweight-repo-mode",
  sinceVersion: "1.35.0",
  titleKey: "feat_lightweight_repo_title",
  bodyKey: "feat_lightweight_repo_body",
  targetId: "lightweight-repo",
} satisfies FeatureAnnouncement;

export default entry;
