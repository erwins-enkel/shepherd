import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Auto-retire push surface (#852): a daily background pass that retires underperforming
  // rules now also fires a push notification. No targetId — the surface is an OS push, not
  // an on-screen element. v1.34.0 latest released → 1.35.0.
  id: "learnings-retire-push",
  sinceVersion: "1.35.0",
  titleKey: "feat_learnings_retire_push_title",
  bodyKey: "feat_learnings_retire_push_body",
} satisfies FeatureAnnouncement;

export default entry;
