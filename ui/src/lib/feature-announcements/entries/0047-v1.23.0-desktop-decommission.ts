import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the hover ✕ on session-list rows is revealed on hover (not
  // persistently mounted) and the header ✕ only renders for non-PR-ready sessions,
  // so both anchors are conditionally present — surface via the What's-New drawer only.
  id: "desktop-decommission",
  sinceVersion: "1.23.0",
  titleKey: "feat_desktop_decom_title",
  bodyKey: "feat_desktop_decom_body",
} satisfies FeatureAnnouncement;

export default entry;
