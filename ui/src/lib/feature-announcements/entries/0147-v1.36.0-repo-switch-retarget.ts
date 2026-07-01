import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the behaviour fires on a repo-chip switch in the RepoSwitcher rail
  // (only rendered when ≥2 repos have a live session), and the effect re-targets the
  // terminal rather than highlighting a control — there's no stable anchor to point a
  // coachmark at. Surface via the What's-New drawer only. v1.35.0 is the latest
  // released tag → ships in 1.36.0.
  id: "repo-switch-retarget",
  sinceVersion: "1.36.0",
  titleKey: "feat_repo_switch_retarget_title",
  bodyKey: "feat_repo_switch_retarget_body",
} satisfies FeatureAnnouncement;

export default entry;
