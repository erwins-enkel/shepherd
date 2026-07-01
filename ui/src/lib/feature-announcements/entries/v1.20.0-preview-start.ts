import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the Start control only renders on an agent with no bound preview port,
  // so a coachmark anchor would rarely be mounted — surface via the What's-New drawer only.
  id: "preview-start",
  sinceVersion: "1.20.0",
  titleKey: "feat_preview_start_title",
  bodyKey: "feat_preview_start_body",
} satisfies FeatureAnnouncement;

export default entry;
