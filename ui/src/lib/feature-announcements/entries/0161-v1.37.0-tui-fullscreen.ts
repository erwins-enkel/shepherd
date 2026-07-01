import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Operators can opt agent sessions into Claude Code's fullscreen renderer (Settings → Session),
  // a research preview for flatter memory on long autonomous runs; off by default. No targetId —
  // surfaced via the What's-New drawer only. v1.36.0 is the latest released tag → ships in 1.37.0.
  id: "tui-fullscreen",
  sinceVersion: "1.37.0",
  titleKey: "feat_tui_fullscreen_title",
  bodyKey: "feat_tui_fullscreen_body",
} satisfies FeatureAnnouncement;

export default entry;
