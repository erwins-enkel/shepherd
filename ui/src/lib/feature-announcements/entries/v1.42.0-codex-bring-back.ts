import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Bring back (restore) now works for isolated Codex sessions, not just Claude: restore re-creates
  // the worktree and resumes the exact Codex conversation via `codex resume <session-id>` (the id is
  // derived fresh from the rollout at restore time). 1.41.0 is the latest released tag, so this ships
  // in 1.42.0. No targetId — the button only renders when a done session is selected in the Done lens.
  id: "codex-bring-back",
  sinceVersion: "1.42.0",
  titleKey: "feat_codex_bring_back_title",
  bodyKey: "feat_codex_bring_back_body",
} satisfies FeatureAnnouncement;

export default entry;
