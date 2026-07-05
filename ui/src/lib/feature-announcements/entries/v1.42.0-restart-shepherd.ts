import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // One-click Restart Shepherd: a Session-tab settings action plus Restart-now
  // buttons on the plugin restart banners, replacing the copy-paste systemctl
  // command. The confirm dialog optionally restarts the herdr daemon too, via a
  // graceful live-handoff (panes survive).
  id: "restart-shepherd",
  sinceVersion: "1.42.0",
  titleKey: "feat_restart_shepherd_title",
  bodyKey: "feat_restart_shepherd_body",
} satisfies FeatureAnnouncement;

export default entry;
