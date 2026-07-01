import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Glob-scoped house rules (#842): a learning can carry scopeGlobs so it injects
  // only for tasks touching matching files; surfaced in the Learnings drawer (scope
  // line + editor + "Scoped" badge). v1.34.0 is the latest released tag → 1.35.0.
  id: "scoped-learnings",
  sinceVersion: "1.35.0",
  titleKey: "feat_scoped_learnings_title",
  bodyKey: "feat_scoped_learnings_body",
} satisfies FeatureAnnouncement;

export default entry;
