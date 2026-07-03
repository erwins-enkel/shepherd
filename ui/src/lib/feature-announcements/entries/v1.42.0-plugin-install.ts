import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Install-from-URL manager in Settings → Plugins: paste a GitHub URL to clone a plugin
  // into ~/.shepherd/plugins/, plus uninstall. 1.41.x is the latest released line, so this
  // ships in 1.42.0 (from `bun run next-version`).
  id: "plugin-install",
  sinceVersion: "1.42.0",
  titleKey: "feat_plugin_install_title",
  bodyKey: "feat_plugin_install_body",
} satisfies FeatureAnnouncement;

export default entry;
