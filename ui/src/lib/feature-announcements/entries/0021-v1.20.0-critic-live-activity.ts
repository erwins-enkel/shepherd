import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the critic badge only renders while a PR critic is actively reviewing,
  // so a coachmark anchor would rarely be mounted — surface via the What's-New drawer only.
  id: "critic-live-activity",
  sinceVersion: "1.20.0",
  titleKey: "feat_critic_activity_title",
  bodyKey: "feat_critic_activity_body",
} satisfies FeatureAnnouncement;

export default entry;
