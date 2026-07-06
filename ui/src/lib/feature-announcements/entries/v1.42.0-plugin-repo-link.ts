import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Settings -> Plugins now surfaces a manifest-declared repository URL as a host-owned
  // external link beside the installed-plugin actions. This is distinct from plugin docs
  // or plugin-authored status/UI.
  id: "plugin-repo-link",
  sinceVersion: "1.42.0",
  titleKey: "feat_plugin_repo_link_title",
  bodyKey: "feat_plugin_repo_link_body",
} satisfies FeatureAnnouncement;

export default entry;
