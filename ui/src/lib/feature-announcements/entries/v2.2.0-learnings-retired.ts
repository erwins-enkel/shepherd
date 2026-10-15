import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Learnings retired (#3139). No targetId: the drawer and its controls are gone.
  id: "learnings-retired",
  sinceVersion: "2.2.0",
  titleKey: "feat_learnings_retired_title",
  bodyKey: "feat_learnings_retired_body",
} satisfies FeatureAnnouncement;

export default entry;
