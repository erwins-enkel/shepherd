import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // After you manually merge a session's PR, the "Merged" toast now offers a one-click
  // Decommission action to tear down that finished session (stop the agent, remove the
  // worktree) without hunting for the decommission button. No targetId — the offer is a
  // transient toast with no persistent anchor; surface via the What's-New drawer only.
  // v1.36.0 is the latest released tag → ships in 1.37.0.
  id: "decommission-on-merge",
  sinceVersion: "1.37.0",
  titleKey: "feat_decommission_on_merge_title",
  bodyKey: "feat_decommission_on_merge_body",
} satisfies FeatureAnnouncement;

export default entry;
