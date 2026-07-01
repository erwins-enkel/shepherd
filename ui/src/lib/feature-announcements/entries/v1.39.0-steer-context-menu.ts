import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Right-clicking a steer chip now opens a small context menu offering Run (the
  // same as a tap) or Edit (jumps into the steers editor focused on that steer).
  // No targetId — the steer bar only mounts on a focused session's terminal tab,
  // so there's no always-present anchor; surface via the What's-New drawer only.
  // 1.38.0 is the latest released tag, so this ships in 1.39.0.
  id: "steer-context-menu",
  sinceVersion: "1.39.0",
  titleKey: "feat_steer_context_menu_title",
  bodyKey: "feat_steer_context_menu_body",
} satisfies FeatureAnnouncement;

export default entry;
