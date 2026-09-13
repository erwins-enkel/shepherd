import type { FeatureAnnouncement } from "../../feature-announcements";

// Covers the phone list rework end to end, in ONE entry: the lens moving into the bottom bar
// (D10), the repo rail moving into the Repos sheet (D14), and the bar then collapsing from two
// ranks to a single flat row — which is what sent BOTH the Done and the Owed lens into the gear
// menu. The two-rank stage never shipped in a release (it landed while 1.47.0 was current), so
// announcing it separately would tell operators about a bar they never saw.
export default {
  id: "mobile-thumb-nav",
  sinceVersion: "1.48.0",
  titleKey: "feat_mobile_thumb_nav_title",
  bodyKey: "feat_mobile_thumb_nav_body",
  targetId: "mobile-seg-ctrl",
} satisfies FeatureAnnouncement;
