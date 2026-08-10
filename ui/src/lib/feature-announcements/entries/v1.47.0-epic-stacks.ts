import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  id: "epic-stacks",
  sinceVersion: "1.47.0",
  titleKey: "feat_epic_stacks_title",
  bodyKey: "feat_epic_stacks_body",
  // No targetId: the switch lives in the Automation popover, which is not one of the coachmark
  // pill targets, and the capability is opt-in per repo anyway.
} satisfies FeatureAnnouncement;

export default entry;
