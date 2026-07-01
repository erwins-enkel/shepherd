import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the Preview badge only renders when a dev-server port is detected in the
  // agent's worktree, so a coachmark anchor would rarely be mounted — surface via the
  // What's-New drawer only.
  id: "live-preview",
  sinceVersion: "1.20.0",
  titleKey: "feat_preview_title",
  bodyKey: "feat_preview_body",
} satisfies FeatureAnnouncement;

export default entry;
