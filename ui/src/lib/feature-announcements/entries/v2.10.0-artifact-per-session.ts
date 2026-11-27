import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // #4293: a session whose task did not start with /design can enable Claude's Artifact tool later.
  // No targetId: the row shows only while a session's Artifact tool is trimmed.
  id: "artifact-per-session",
  sinceVersion: "2.10.0",
  titleKey: "feat_artifact_per_session_title",
  bodyKey: "feat_artifact_per_session_body",
} satisfies FeatureAnnouncement;

export default entry;
