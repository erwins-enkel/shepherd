import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Held tasks now show the coding CLI they were originally held for and can be manually
  // spawned on a different provider, e.g. hand a Claude-held task to Codex while Claude usage is
  // capped. No targetId — the held-task popover only mounts when the queue is non-empty. Ships
  // in 1.37.0 alongside the Codex provider path.
  id: "held-task-cli-handoff",
  sinceVersion: "1.37.0",
  titleKey: "feat_held_task_cli_handoff_title",
  bodyKey: "feat_held_task_cli_handoff_body",
} satisfies FeatureAnnouncement;

export default entry;
