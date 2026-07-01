import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Per-task rows in the Usage → Spend + Overhead lenses now show each task's
  // human-readable short name (e.g. "add-auth-flow") with its designation as a muted
  // tag, instead of the designation alone. No targetId — the task rows mount only when a
  // repo group is expanded, so there is no persistently-mounted anchor for a coachmark;
  // surface via the What's-New drawer only. v1.36.0 is the latest released tag → ships in 1.37.0.
  id: "usage-task-names",
  sinceVersion: "1.37.0",
  titleKey: "feat_usage_task_names_title",
  bodyKey: "feat_usage_task_names_body",
} satisfies FeatureAnnouncement;

export default entry;
