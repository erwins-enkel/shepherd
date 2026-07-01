import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // #1226: isolated-session post-merge toast now offers a combined "Decommission &
  // update local" action (restores the local fast-forward removed in #1121, folded
  // into the one Decommission offer). No targetId — a transient toast action is not a
  // stable coachmark anchor; What's-New drawer only. 1.38.0 is the latest released tag.
  id: "decommission-and-update-local",
  sinceVersion: "1.39.0",
  titleKey: "feat_decommission_update_local_title",
  bodyKey: "feat_decommission_update_local_body",
} satisfies FeatureAnnouncement;

export default entry;
