import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Hidden repos are now dropped from the New Task repo picker (default list + recents
  // + Alt cycle/digit shortcuts) and revealed only on name search. targetId "nt-repo"
  // is the existing coachmark anchor on the repo field in NewTask.svelte, so the
  // coachmark points at the picker when the New Task dialog is open. Ships in 1.39.0.
  id: "newtask-hide-hidden-repos",
  sinceVersion: "1.39.0",
  titleKey: "feat_newtask_hide_hidden_title",
  bodyKey: "feat_newtask_hide_hidden_body",
  targetId: "nt-repo",
} satisfies FeatureAnnouncement;

export default entry;
