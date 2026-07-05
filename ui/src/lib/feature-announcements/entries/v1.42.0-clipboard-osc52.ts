import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Claude's `c to copy` (OSC 52) now reaches the browser clipboard — previously
  // dropped silently because xterm.js has no built-in OSC 52 handler.
  id: "clipboard-osc52",
  sinceVersion: "1.42.0",
  titleKey: "feat_clipboard_osc52_title",
  bodyKey: "feat_clipboard_osc52_body",
} satisfies FeatureAnnouncement;

export default entry;
