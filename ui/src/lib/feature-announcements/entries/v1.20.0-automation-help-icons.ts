import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the "ⓘ" buttons live inside the automation popover, which is
  // closed by default, so a coachmark anchor would rarely be mounted — surface
  // via the What's-New drawer only.
  id: "automation-help-icons",
  sinceVersion: "1.20.0",
  titleKey: "feat_automation_help_title",
  bodyKey: "feat_automation_help_body",
} satisfies FeatureAnnouncement;

export default entry;
