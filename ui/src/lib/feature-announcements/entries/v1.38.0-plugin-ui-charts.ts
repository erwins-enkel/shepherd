import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Plugin UI graphical widgets (#1189): plugins can publishUI() gauges, sparklines,
  // time-series, bar-charts and timelines, rendered from the whitelisted registry in
  // Settings → Plugins, alongside the existing meter/badge/table widgets. 1.37.0 is the
  // latest released tag, so this ships in 1.38.0. No targetId — same dead-anchor limitation
  // as plugin-ui-panels (Settings → Plugins isn't a Coachmark arming host); What's-New only.
  id: "plugin-ui-charts",
  sinceVersion: "1.38.0",
  titleKey: "feat_plugin_ui_charts_title",
  bodyKey: "feat_plugin_ui_charts_body",
} satisfies FeatureAnnouncement;

export default entry;
