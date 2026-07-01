import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // The mobile terminal control bar gains a pinned ⤓ "jump to latest" key in the right-hand
  // action cluster, mirroring Claude Code's Ctrl+End scroll-to-bottom — always reachable, unlike
  // the floating ↓ that only appears when scrolled up. No targetId — the control bar mounts on
  // mobile/touch only; surface via the What's-New drawer only. v1.36.0 is the latest released tag → ships in 1.37.0.
  id: "mobile-scroll-to-end-key",
  sinceVersion: "1.37.0",
  titleKey: "feat_scroll_to_end_key_title",
  bodyKey: "feat_scroll_to_end_key_body",
} satisfies FeatureAnnouncement;

export default entry;
