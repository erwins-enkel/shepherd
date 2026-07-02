import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Command-bar Alt+digit quick-jump: hold Alt with the command bar open to reveal 1–9,0 hints
  // on the first ten results, then press the digit to jump straight to it. (Cmd/Ctrl+digit is
  // browser-reserved for tab-switch/reset-zoom, so Alt is the single-modifier substitute.)
  // 1.40.0 is the latest released tag, so this ships in 1.41.0. No targetId — the command bar
  // opens via a chord and has no persistent anchor to arm a Coachmark on; What's-New only.
  id: "command-bar-jump",
  sinceVersion: "1.41.0",
  titleKey: "feat_command_bar_jump_title",
  bodyKey: "feat_command_bar_jump_body",
} satisfies FeatureAnnouncement;

export default entry;
