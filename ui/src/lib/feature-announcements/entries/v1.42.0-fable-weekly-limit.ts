import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Fable has its own separate weekly limit in Claude Code's /usage; the usage panel now
  // surfaces it as its own bar (top-bar popover + Usage dashboard Limits tab) so you can see
  // how close you are to the Fable-specific cap, not just the aggregate weekly window.
  id: "fable-weekly-limit",
  sinceVersion: "1.42.0",
  titleKey: "feat_fable_weekly_title",
  bodyKey: "feat_fable_weekly_body",
} satisfies FeatureAnnouncement;

export default entry;
