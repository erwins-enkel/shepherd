import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Issue steers ride the New Task compose row (keyboard up, touch) between hide-keyboard
  // and Next, scrolling sideways when they overflow. No coachmark: the row is transient.
  id: "compose-steers",
  sinceVersion: "2.2.0",
  titleKey: "feat_compose_steers_title",
  bodyKey: "feat_compose_steers_body",
} satisfies FeatureAnnouncement;

export default entry;
