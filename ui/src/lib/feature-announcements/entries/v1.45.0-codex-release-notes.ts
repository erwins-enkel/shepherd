import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // The update modal only exists while a Codex update is available, so there is
  // no stable always-mounted coach target; announce it in What's New instead.
  id: "codex-release-notes",
  sinceVersion: "1.45.0",
  titleKey: "feat_codex_release_notes_title",
  bodyKey: "feat_codex_release_notes_body",
} satisfies FeatureAnnouncement;

export default entry;
