import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: command links appear inline in the terminal output, which has no
  // stable mountable anchor — surface via the What's-New drawer only.
  // 1.29.0 is the latest released tag, so this ships in 1.30.0.
  id: "tappable-slash-commands",
  sinceVersion: "1.30.0",
  titleKey: "feat_tappable_slash_commands_title",
  bodyKey: "feat_tappable_slash_commands_body",
} satisfies FeatureAnnouncement;

export default entry;
