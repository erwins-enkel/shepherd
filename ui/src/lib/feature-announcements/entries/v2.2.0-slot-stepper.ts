import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // − / + beside the agent-slot count in Repos → Issues (list heading, run area's Now step) step
  // the repo's cap in place. No targetId: like epic-run-control, it only mounts inside the Repos
  // dialog, and it renders in two places at once.
  id: "slot-stepper",
  sinceVersion: "2.2.0",
  titleKey: "feat_slot_stepper_title",
  bodyKey: "feat_slot_stepper_body",
} satisfies FeatureAnnouncement;

export default entry;
