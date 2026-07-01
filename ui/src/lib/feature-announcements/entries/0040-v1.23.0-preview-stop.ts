import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the Stop button only mounts when a preview is live AND the preview
  // tab is open, so a coachmark anchor would usually be unmounted — surface via the
  // What's-New drawer only. v1.22.0 is already tagged, so this ships in the next
  // release (1.23.0): computeNewEntries only surfaces entries with sinceVersion > lastSeen.
  id: "preview-stop",
  sinceVersion: "1.23.0",
  titleKey: "feat_preview_stop_title",
  bodyKey: "feat_preview_stop_body",
} satisfies FeatureAnnouncement;

export default entry;
