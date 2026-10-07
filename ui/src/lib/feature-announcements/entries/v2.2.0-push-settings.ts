import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Settings → Notifications (#2696): native iOS push set up from the dialog instead of
  // SHEPHERD_APNS_* — upload the APNs key, see its state, test and tune every device. The
  // control lives behind the settings gear, so What's-New only, no coachmark.
  id: "push-settings",
  sinceVersion: "2.2.0",
  titleKey: "feat_push_settings_title",
  bodyKey: "feat_push_settings_body",
} satisfies FeatureAnnouncement;

export default entry;
