import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  id: "stacked-prs",
  sinceVersion: "1.47.0",
  titleKey: "feat_stacked_prs_title",
  bodyKey: "feat_stacked_prs_body",
  // No targetId: the Merge button already exists and looks unchanged — what changed is what
  // happens behind it, and the merge-train hold only appears on a repo that actually has a stack.
} satisfies FeatureAnnouncement;

export default entry;
