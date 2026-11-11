import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // The ⚙ pill + autopilot toggle row left the session header: repo settings and the session's
  // autopilot override now live in the session's Auto tab; Diff moved into Files.
  id: "automation-tab",
  sinceVersion: "2.8.0",
  titleKey: "feat_automation_tab_title",
  bodyKey: "feat_automation_tab_body",
  targetId: "automation-tab",
} satisfies FeatureAnnouncement;
