import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the New Task prompt-sources issue list only mounts inside the open
  // New Task dialog, so a coachmark anchor would usually be unmounted — surface via
  // the What's-New drawer only.
  id: "active-label-newtask",
  sinceVersion: "1.21.0",
  titleKey: "feat_active_label_newtask_title",
  bodyKey: "feat_active_label_newtask_body",
} satisfies FeatureAnnouncement;

export default entry;
