import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // The offer surfaces as a transient post-merge toast (no persistent anchor
  // element to point a coachmark at), so What's-New drawer only — no targetId.
  id: "update-local-checkout-after-merge",
  sinceVersion: "1.20.0",
  titleKey: "feat_update_checkout_title",
  bodyKey: "feat_update_checkout_body",
} satisfies FeatureAnnouncement;

export default entry;
