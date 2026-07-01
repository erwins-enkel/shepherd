import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // 1M-context Opus & Sonnet are now selectable in every model picker (New Task,
  // global default, per-repo automation). targetId "model-1m-context" matches
  // use:coachTarget on the New Task model field.
  // v1.34.0 is the latest released tag → ships in 1.35.0.
  id: "model-1m-context",
  sinceVersion: "1.35.0",
  titleKey: "feat_model_1m_title",
  bodyKey: "feat_model_1m_body",
  targetId: "model-1m-context",
} satisfies FeatureAnnouncement;

export default entry;
