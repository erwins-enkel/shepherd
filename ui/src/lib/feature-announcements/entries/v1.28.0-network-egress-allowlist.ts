import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the egress badge only renders on autonomous sessions and the
  // egress-drop toast fires transiently — no persistent anchor element to point a
  // coachmark at. Surface via the What's-New drawer only.
  id: "network-egress-allowlist",
  sinceVersion: "1.28.0",
  titleKey: "feat_egress_title",
  bodyKey: "feat_egress_body",
} satisfies FeatureAnnouncement;

export default entry;
