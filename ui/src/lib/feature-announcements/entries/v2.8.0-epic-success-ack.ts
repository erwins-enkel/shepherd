import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // #3838: a succeeded epic stays in the Herd until the operator confirms its completion.
  id: "epic-success-ack",
  sinceVersion: "2.8.0",
  titleKey: "feat_epic_success_ack_title",
  bodyKey: "feat_epic_success_ack_body",
} satisfies FeatureAnnouncement;
