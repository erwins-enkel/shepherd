import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Secondary command-bar action (#1338 follow-up): ⇧↵ / ⌘/Ctrl+↵ on a repository
  // result filters the session list to that repo (the same repoFilter the RepoSwitcher
  // chips drive), while plain ↵ keeps opening its backlog. Offered only for repos with
  // a live session, so the announcement body scopes the claim to "active sessions".
  // No targetId — the command bar's only opener is the ⌘/Ctrl+K chord, no stable anchor.
  id: "command-bar-repo-filter",
  sinceVersion: "1.41.0",
  titleKey: "feat_command_bar_repo_filter_title",
  bodyKey: "feat_command_bar_repo_filter_body",
} satisfies FeatureAnnouncement;

export default entry;
