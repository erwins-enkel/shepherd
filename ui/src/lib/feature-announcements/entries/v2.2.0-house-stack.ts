import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Settings → Workspace "House Stack" (#3108). No targetId: it lives inside the Settings dialog.
  id: "house-stack",
  sinceVersion: "2.2.0",
  titleKey: "feat_house_stack_title",
  bodyKey: "feat_house_stack_body",
} satisfies FeatureAnnouncement;

export default entry;
