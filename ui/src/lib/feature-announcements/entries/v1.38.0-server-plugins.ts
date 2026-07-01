import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Server-side plugin architecture (#1124): a Settings → Plugins panel surfaces
  // loaded private/out-of-repo extensions + their health. No targetId — the tab only
  // mounts when ≥1 plugin is loaded, so a coachmark would point at nothing for most.
  // 1.37.0 is the latest released tag, so this ships in 1.38.0.
  id: "server-plugins",
  sinceVersion: "1.38.0",
  titleKey: "feat_server_plugins_title",
  bodyKey: "feat_server_plugins_body",
} satisfies FeatureAnnouncement;

export default entry;
