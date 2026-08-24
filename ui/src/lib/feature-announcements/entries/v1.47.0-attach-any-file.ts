import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the attach button only mounts on the selected session's viewport (and only in
  // the mobile/touch control row), which isn't guaranteed to be open on first view — surface via
  // the What's-New drawer only.
  id: "attach-any-file",
  sinceVersion: "1.47.0",
  titleKey: "feat_attach_any_file_title",
  bodyKey: "feat_attach_any_file_body",
} satisfies FeatureAnnouncement;

export default entry;
