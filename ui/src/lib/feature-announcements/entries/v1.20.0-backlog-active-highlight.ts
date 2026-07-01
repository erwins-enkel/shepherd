import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the highlighted chip only renders on issues currently claimed by a
  // Shepherd agent, so a coachmark anchor would rarely be mounted — surface via the
  // What's-New drawer only.
  id: "backlog-active-highlight",
  sinceVersion: "1.20.0",
  titleKey: "feat_backlog_active_highlight_title",
  bodyKey: "feat_backlog_active_highlight_body",
} satisfies FeatureAnnouncement;

export default entry;
