import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the Start control only renders on sessions without a live preview;
  // most users will encounter this via the What's-New drawer rather than a stable anchor.
  id: "preview-local-script",
  sinceVersion: "1.39.0",
  titleKey: "feat_preview_local_script_title",
  bodyKey: "feat_preview_local_script_body",
} satisfies FeatureAnnouncement;

export default entry;
