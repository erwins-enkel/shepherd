import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Command bar v2 (#1338): the Cmd/Ctrl+K bar now also runs verbs (Commands group)
  // and searches the docs (Docs group), on top of v1's session/repo/lens navigation.
  // Distinct from the "command-bar" entry — that announces the bar itself; this one
  // announces the new docs+actions capability landing in the same 1.41.0 train.
  // No targetId — the trigger is a global keyboard shortcut with no stable anchor.
  id: "command-bar-v2",
  sinceVersion: "1.41.0",
  titleKey: "feat_command_bar_v2_title",
  bodyKey: "feat_command_bar_v2_body",
} satisfies FeatureAnnouncement;

export default entry;
