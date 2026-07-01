import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the freshen happens at task-launch time (no persistent anchor
  // element) and the New Task behind/diverged hint lives inside the New Task dialog
  // (closed by default) — surface via the What's-New drawer only. 1.33.0 is the
  // latest released tag, so this ships in 1.34.0.
  id: "base-freshen",
  sinceVersion: "1.34.0",
  titleKey: "feat_base_freshen_title",
  bodyKey: "feat_base_freshen_body",
} satisfies FeatureAnnouncement;

export default entry;
