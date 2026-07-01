import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the steers editor lives inside Settings (closed by default), so a
  // coachmark anchor would rarely be mounted — surface via the What's-New drawer
  // only. 1.27.0 is already released, so this ships in 1.28.0.
  id: "steers-prompt-slash-commands",
  sinceVersion: "1.28.0",
  titleKey: "feat_steers_prompt_editor_title",
  bodyKey: "feat_steers_prompt_editor_body",
} satisfies FeatureAnnouncement;

export default entry;
