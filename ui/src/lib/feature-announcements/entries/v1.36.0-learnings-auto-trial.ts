import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Auto-trial strong proposals (#925): proposals with strong, multi-source evidence are
  // auto-promoted to active "trials" (and the Wilson auto-retire net removes duds), draining
  // the manual approval queue. Trials are badged + one-click revertible in the drawer.
  id: "learnings-auto-trial",
  sinceVersion: "1.36.0",
  titleKey: "feat_learnings_auto_trial_title",
  bodyKey: "feat_learnings_auto_trial_body",
} satisfies FeatureAnnouncement;

export default entry;
