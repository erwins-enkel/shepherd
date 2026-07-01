import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: keyboard shortcuts are invisible chrome (documented in the
  // viewport footer hint line) — surface via the What's-New drawer only.
  id: "herd-keyboard-nav",
  sinceVersion: "1.22.0",
  titleKey: "feat_herd_keynav_title",
  bodyKey: "feat_herd_keynav_body",
} satisfies FeatureAnnouncement;

export default entry;
