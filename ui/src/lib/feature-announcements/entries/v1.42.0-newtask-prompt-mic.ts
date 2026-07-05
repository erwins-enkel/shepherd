import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  id: "newtask-prompt-mic",
  sinceVersion: "1.42.0",
  titleKey: "feat_newtask_prompt_mic_title",
  bodyKey: "feat_newtask_prompt_mic_body",
  // No targetId: the mic lives inside the New Task dialog (closed by default) AND only
  // renders when a dictation engine is available, so a coachmark could never reliably
  // find its anchor — What's-New drawer only.
} satisfies FeatureAnnouncement;

export default entry;
