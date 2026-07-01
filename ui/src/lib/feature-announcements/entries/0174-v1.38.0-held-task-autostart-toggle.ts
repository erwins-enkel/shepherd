import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // The held-task popover now has an "auto-start" checkbox. Off keeps tasks queued until the
  // operator starts each one manually instead of releasing them automatically at the next reset.
  // No targetId — the held-task popover only mounts when the queue is non-empty. Ships in 1.38.0
  // (v1.37.0 is already released; this lands after the tag).
  id: "held-task-autostart-toggle",
  sinceVersion: "1.38.0",
  titleKey: "feat_held_autostart_title",
  bodyKey: "feat_held_autostart_body",
} satisfies FeatureAnnouncement;

export default entry;
