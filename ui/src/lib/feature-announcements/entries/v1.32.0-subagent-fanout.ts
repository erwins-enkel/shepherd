import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // targetId "subagent-fanout" anchors the coachmark on the fan-out section in
  // the Activity tab. 1.31.0 is the latest released tag, so this ships in 1.32.0.
  id: "subagent-fanout",
  sinceVersion: "1.32.0",
  titleKey: "feat_subagent_fanout_title",
  bodyKey: "feat_subagent_fanout_body",
  targetId: "subagent-fanout",
} satisfies FeatureAnnouncement;

export default entry;
