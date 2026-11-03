import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // Provenance of self-updates (#3623): Settings → Update + `update_call` signals.
  id: "update-origin",
  sinceVersion: "2.7.0",
  titleKey: "feat_update_origin_title",
  bodyKey: "feat_update_origin_body",
} satisfies FeatureAnnouncement;
