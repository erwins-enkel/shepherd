import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: keyboard shortcuts are invisible chrome (documented in the
  // viewport footer hint line) — surface via the What's-New drawer only. Ships
  // in 1.39.0.
  id: "session-switch-tab-brackets",
  sinceVersion: "1.39.0",
  titleKey: "feat_session_switch_tab_title",
  bodyKey: "feat_session_switch_tab_body",
} satisfies FeatureAnnouncement;

export default entry;
