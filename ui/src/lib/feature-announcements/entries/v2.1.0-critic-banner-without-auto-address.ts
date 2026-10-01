import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the review-in-flight banner is not a <Coachmark> host (see
  // v1.43.0-review-live-preview.ts), so this surfaces via the What's-New drawer.
  id: "critic-banner-without-auto-address",
  sinceVersion: "2.1.0",
  titleKey: "feat_critic_banner_without_auto_address_title",
  bodyKey: "feat_critic_banner_without_auto_address_body",
} satisfies FeatureAnnouncement;

export default entry;
