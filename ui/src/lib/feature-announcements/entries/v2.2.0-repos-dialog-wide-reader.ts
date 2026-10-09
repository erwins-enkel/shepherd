import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Repos → Issues: ~380px list with wrapping rows, the reading view's text beside its controls,
  // and the tab row's Overview button. No targetId: like slot-stepper, it only mounts inside the
  // Repos dialog and spans several surfaces.
  id: "repos-dialog-wide-reader",
  sinceVersion: "2.2.0",
  titleKey: "feat_repos_dialog_wide_reader_title",
  bodyKey: "feat_repos_dialog_wide_reader_body",
} satisfies FeatureAnnouncement;

export default entry;
