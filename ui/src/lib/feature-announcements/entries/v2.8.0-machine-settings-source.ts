import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // Settings → Machines (#3967): a connected machine can be the live source of steers and repo
  // emojis; edits save there, offline shows its last known state read-only.
  id: "machine-settings-source",
  sinceVersion: "2.8.0",
  titleKey: "feat_machine_settings_source_title",
  bodyKey: "feat_machine_settings_source_body",
} satisfies FeatureAnnouncement;
