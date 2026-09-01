import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // The floating `fable` alias now resolves to Fable 5.1 in the installed CLI, and the picker
  // additionally offers "Fable 5.1" as a pinned entry so a future Fable release can't silently
  // take the alias over. Usage costs follow 5.1's cheaper cache-read price.
  id: "fable-5-1",
  sinceVersion: "1.48.0",
  titleKey: "feat_fable_5_1_title",
  bodyKey: "feat_fable_5_1_body",
} satisfies FeatureAnnouncement;

export default entry;
