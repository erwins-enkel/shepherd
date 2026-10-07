import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Automation → repo → "Shared browser" toggle + "Open shared browser". No targetId: the toggle
  // only mounts inside the repo's automation settings.
  id: "shared-browser",
  sinceVersion: "2.2.0",
  titleKey: "feat_shared_browser_title",
  bodyKey: "feat_shared_browser_body",
} satisfies FeatureAnnouncement;

export default entry;
