import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // #3555: every heavy check in its own memory-limited systemd scope (Linux with agent scopes).
  id: "heavy-run-memory-limit",
  sinceVersion: "2.7.0",
  titleKey: "feat_heavy_run_memory_title",
  bodyKey: "feat_heavy_run_memory_body",
} satisfies FeatureAnnouncement;
