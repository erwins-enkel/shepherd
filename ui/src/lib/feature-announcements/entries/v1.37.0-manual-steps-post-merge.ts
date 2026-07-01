import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // P3 of the manual-operator-steps epic (#1061): declared steps now outlive the session. On
  // merge they're materialized into a durable record (kept past archive + the prune window) and
  // surfaced in the new "Owed" Herd lens, where the operator ticks each off; they persist until
  // done. A per-repo opt-in additionally opens a GitHub tracking issue on merge, linked back to
  // the PR. targetId points at the Owed lens chip in the herd filter bar. Ships in 1.37.0.
  id: "manual-steps-post-merge",
  sinceVersion: "1.37.0",
  titleKey: "feat_manual_steps_post_merge_title",
  bodyKey: "feat_manual_steps_post_merge_body",
  targetId: "owed-lens",
} satisfies FeatureAnnouncement;

export default entry;
