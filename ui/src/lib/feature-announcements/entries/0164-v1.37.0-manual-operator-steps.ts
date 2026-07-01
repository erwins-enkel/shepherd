import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Shepherd now detects manual operator steps declared in a PR's `shepherd:manual-steps` block
  // (flip a flag, set an env var, run a backfill) and surfaces them as an amber chip on the
  // session row + a checklist in the Done recap — so they aren't lost when the PR lands. No
  // targetId — the chip mounts only when steps are detected; surface via the What's-New drawer
  // only. v1.36.0 is the latest released tag → ships in 1.37.0.
  id: "manual-operator-steps",
  sinceVersion: "1.37.0",
  titleKey: "feat_manual_operator_steps_title",
  bodyKey: "feat_manual_operator_steps_body",
} satisfies FeatureAnnouncement;

export default entry;
