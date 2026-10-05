import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // The native iOS composer shows live upload progress (percent, file count, time left) and
  // lets Start be tapped mid-upload: the session then starts on its own once the upload
  // finishes, with a short background grace for app switches. Native-only, so no coachmark.
  id: "ios-upload-autostart",
  sinceVersion: "2.2.0",
  titleKey: "feat_ios_upload_autostart_title",
  bodyKey: "feat_ios_upload_autostart_body",
} satisfies FeatureAnnouncement;

export default entry;
