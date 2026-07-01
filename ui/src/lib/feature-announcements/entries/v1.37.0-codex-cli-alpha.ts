import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Codex CLI support is an Alpha/MVP provider path in the task dialog plus Settings →
  // Coding CLIs. No targetId — both controls live in modal surfaces that are closed by default;
  // surface via the What's-New drawer only. Ships in 1.37.0.
  id: "codex-cli-alpha",
  sinceVersion: "1.37.0",
  titleKey: "feat_codex_cli_title",
  bodyKey: "feat_codex_cli_body",
} satisfies FeatureAnnouncement;

export default entry;
