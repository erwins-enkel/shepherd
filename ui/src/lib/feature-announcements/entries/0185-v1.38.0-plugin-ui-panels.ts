import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Plugin UI descriptor (#1185): plugins can publishUI() a declarative view (meters,
  // badges, tables, key-value) rendered from a whitelisted registry in Settings → Plugins,
  // replacing the raw JSON dump. 1.37.0 is the latest released tag, so this ships in 1.38.0.
  // No targetId — the Settings → Plugins tab is conditionally mounted (hidden when no
  // plugins) and isn't a Coachmark arming host, so any targetId would be a dead anchor
  // (same single-host limitation noted on backlog-add-repo); surface via What's-New only.
  id: "plugin-ui-panels",
  sinceVersion: "1.38.0",
  titleKey: "feat_plugin_ui_title",
  bodyKey: "feat_plugin_ui_body",
} satisfies FeatureAnnouncement;

export default entry;
