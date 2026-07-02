import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Cmd/Ctrl+K quick-switcher over sessions, repositories and herd lenses (#1334).
  // Now fuzzy: matches are subsequence-scored with matched letters highlighted, and
  // sessions also match on their description — folded into this same entry rather than a
  // second card since the command bar is still unreleased on this train.
  // No targetId — the trigger is a global keyboard shortcut with no stable anchor
  // element to coach against.
  // v1.41.0 is the current unreleased train (matches the newest sibling entries).
  id: "command-bar",
  sinceVersion: "1.41.0",
  titleKey: "feat_command_bar_title",
  bodyKey: "feat_command_bar_body",
} satisfies FeatureAnnouncement;

export default entry;
