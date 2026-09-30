import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // The epic detail in Repos → Issues gains the flow graph (#2621): the epic's tasks in stages
  // of its dependencies, and from which stage more agent slots help. No targetId: the graph only
  // mounts once an epic is selected in the Repos dialog.
  id: "epic-flow-graph",
  sinceVersion: "2.1.0",
  titleKey: "feat_epic_flow_graph_title",
  bodyKey: "feat_epic_flow_graph_body",
} satisfies FeatureAnnouncement;

export default entry;
