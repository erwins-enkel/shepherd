import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // The epic flow graph's node pulses while its agent works. No targetId: the graph only mounts
  // once an epic is selected in the Repos dialog, so there is no stable anchor on first view.
  id: "epic-flow-working-pulse",
  sinceVersion: "2.1.0",
  titleKey: "feat_epicflow_pulse_title",
  bodyKey: "feat_epicflow_pulse_body",
} satisfies FeatureAnnouncement;

export default entry;
