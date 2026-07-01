import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the action lives in each session card's context menu, and the handoff picker is
  // mounted only after opening it. Surface via the What's-New drawer only.
  id: "continue-with-handoff",
  sinceVersion: "1.39.0",
  titleKey: "feat_continue_with_handoff_title",
  bodyKey: "feat_continue_with_handoff_body",
} satisfies FeatureAnnouncement;

export default entry;
