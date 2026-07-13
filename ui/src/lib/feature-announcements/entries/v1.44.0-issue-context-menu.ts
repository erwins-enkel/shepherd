import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Right-click / long-press an issue row (New Task dialog or backlog) opens a context
  // menu: open on the forge, preview details, or inject an issue steer into the composer
  // (pre-filled, not launched). No targetId — the menu is anchored to a transient
  // right-click, so there's no always-present element to point a coachmark at; surface
  // via the What's-New drawer only. 1.43.0 is the latest released line, so this ships in
  // 1.44.0 (bun run next-version).
  id: "issue-context-menu",
  sinceVersion: "1.44.0",
  titleKey: "feat_issue_context_menu_title",
  bodyKey: "feat_issue_context_menu_body",
} satisfies FeatureAnnouncement;

export default entry;
