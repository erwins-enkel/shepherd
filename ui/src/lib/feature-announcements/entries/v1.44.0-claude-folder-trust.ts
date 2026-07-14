import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Diagnostics now flags when Claude Code hasn't trusted the repo folder (which can leave the
  // usage gauge blank) and offers a one-click fix that seeds the trust flag — no command runs.
  // Copy is neutral: FeatureAnnouncement has no predicate, so this shows to every upgrading user;
  // the check itself only surfaces under subscription auth with Claude Code installed.
  id: "claude-folder-trust",
  sinceVersion: "1.44.0",
  titleKey: "feat_claude_folder_trust_title",
  bodyKey: "feat_claude_folder_trust_body",
} satisfies FeatureAnnouncement;

export default entry;
