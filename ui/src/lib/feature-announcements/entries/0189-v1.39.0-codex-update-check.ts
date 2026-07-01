import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the badge only exists while a codex update is pending, so there
  // is no stable always-present anchor — surface via the What's-New drawer only.
  id: "codex-update-check",
  sinceVersion: "1.39.0",
  titleKey: "feat_codex_update_title",
  bodyKey: "feat_codex_update_body",
} satisfies FeatureAnnouncement;

export default entry;
