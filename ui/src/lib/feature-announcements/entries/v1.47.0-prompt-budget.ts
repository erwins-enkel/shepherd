import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  id: "prompt-budget",
  sinceVersion: "1.47.0",
  titleKey: "feat_prompt_budget_title",
  bodyKey: "feat_prompt_budget_body",
  // Anchors the new Prompt tab inside the Usage modal (see Usage.svelte's coachTarget).
  targetId: "usage-prompt-tab",
} satisfies FeatureAnnouncement;

export default entry;
