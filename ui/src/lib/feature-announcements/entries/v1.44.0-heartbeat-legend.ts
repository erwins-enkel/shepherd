import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the heartbeat strip appears once per live session card in a dense
  // list — many strips can be in the DOM at once, and coachTargets key one node per
  // id, so a duplicated targetId anchor would be wrong. Surface via What's-New only.
  id: "heartbeat-legend",
  sinceVersion: "1.44.0",
  titleKey: "feat_heartbeat_legend_title",
  bodyKey: "feat_heartbeat_legend_body",
} satisfies FeatureAnnouncement;

export default entry;
