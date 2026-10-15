import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Bootstrap phase sequencer + New Project PRD/design import (#3112). No targetId: the checklist
  // only renders for an actively-bootstrapping repo, so a coachmark would usually find no anchor.
  id: "bootstrap-sequencer",
  sinceVersion: "2.2.0",
  titleKey: "feat_bootstrap_sequencer_title",
  bodyKey: "feat_bootstrap_sequencer_body",
} satisfies FeatureAnnouncement;

export default entry;
