import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the slash menu only exists while a "/" is being typed, so there is no
  // element a coachmark could anchor to on first view. What's-New drawer only.
  id: "command-desc-tooltip",
  sinceVersion: "1.46.0",
  titleKey: "feat_command_desc_tooltip_title",
  bodyKey: "feat_command_desc_tooltip_body",
} satisfies FeatureAnnouncement;

export default entry;
