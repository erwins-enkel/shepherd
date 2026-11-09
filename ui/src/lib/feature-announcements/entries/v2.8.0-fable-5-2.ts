import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // The floating `fable` alias now resolves to Fable 5.2 in Claude Code 2.1.321+, and the pinned
  // "Fable 5.2" replaces "Fable 5.1" in the pickers (a saved 5.1 value keeps working). Usage costs
  // follow 5.2's cheaper $8/$40 list price.
  id: "fable-5-2",
  sinceVersion: "2.8.0",
  titleKey: "feat_fable_5_2_title",
  bodyKey: "feat_fable_5_2_body",
} satisfies FeatureAnnouncement;

export default entry;
