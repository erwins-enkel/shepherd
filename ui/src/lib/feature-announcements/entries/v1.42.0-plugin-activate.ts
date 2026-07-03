import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // In-process activation for a freshly installed plugin: Settings → Plugins gains an
  // "Activate" button on a pending row that loads the plugin via the live registry
  // (routes/hooks/gear/UI wire in immediately) — no restart for the common install path.
  // A plugin shipping its own deps still needs bun install + a restart. 1.41.x is the
  // latest released line, so this ships in 1.42.0 (from `bun run next-version`). No
  // targetId — the Activate button only exists while a plugin is pending, so there's no
  // always-present anchor; surface via the What's-New drawer only.
  id: "plugin-activate",
  sinceVersion: "1.42.0",
  titleKey: "feat_plugin_activate_title",
  bodyKey: "feat_plugin_activate_body",
} satisfies FeatureAnnouncement;

export default entry;
