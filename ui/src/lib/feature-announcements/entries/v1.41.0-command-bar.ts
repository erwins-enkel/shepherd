import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Cmd/Ctrl+K quick-switcher over sessions, repositories and herd lenses (#1334).
  // No targetId — the trigger is a global keyboard shortcut with no stable anchor
  // element to coach against.
  // v1.41.0 is the current unreleased train (matches the newest sibling entries).
  id: "command-bar",
  sinceVersion: "1.41.0",
  titleKey: "feat_command_bar_title",
  bodyKey: "feat_command_bar_body",
} satisfies FeatureAnnouncement;

export default entry;
