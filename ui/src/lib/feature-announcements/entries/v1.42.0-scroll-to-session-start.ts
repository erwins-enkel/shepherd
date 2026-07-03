import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // The scrollback affordance now offers both directions when the reader is away
  // from the live prompt. No targetId: it only mounts while scrolled up.
  id: "scroll-to-session-start",
  sinceVersion: "1.42.0",
  titleKey: "feat_scroll_to_session_start_title",
  bodyKey: "feat_scroll_to_session_start_body",
} satisfies FeatureAnnouncement;

export default entry;
