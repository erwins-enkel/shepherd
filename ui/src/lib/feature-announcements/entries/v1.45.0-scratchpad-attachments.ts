import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the Files tab / Attachments folder only mounts for the selected session's
  // viewport, which isn't guaranteed to be open on first view — surface via the What's-New
  // drawer only.
  id: "scratchpad-attachments",
  sinceVersion: "1.45.0",
  titleKey: "feat_scratchpad_attachments_title",
  bodyKey: "feat_scratchpad_attachments_body",
} satisfies FeatureAnnouncement;

export default entry;
