import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Incremental-epic stall warning + "waiting on your merge" line in the epic run area and the
  // draft modal, and overlap hints in the draft review (#3423). No targetId: all mount in detail
  // views or dialogs.
  id: "epic-merge-gate",
  sinceVersion: "2.6.0",
  titleKey: "feat_epic_merge_gate_title",
  bodyKey: "feat_epic_merge_gate_body",
} satisfies FeatureAnnouncement;

export default entry;
