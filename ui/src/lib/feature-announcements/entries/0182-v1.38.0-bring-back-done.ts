import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Bring back a marked-as-done session from the Done lens: re-creates the worktree on its
  // surviving branch and resumes the conversation. Recovers committed work only. 1.37.0 is the
  // latest released tag, so this ships in 1.38.0. No targetId — the button only renders when a
  // done session is selected in the Done lens, so there's no always-present anchor.
  id: "bring-back-done",
  sinceVersion: "1.38.0",
  titleKey: "feat_bring_back_title",
  bodyKey: "feat_bring_back_body",
} satisfies FeatureAnnouncement;

export default entry;
