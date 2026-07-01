import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // One-click global promote (#872): the cross-repo recurrence card now has a guarded
  // (two-step confirm) action that writes the rule straight into the user-global
  // ~/.claude/CLAUDE.md — no PR. Lives in the closed-by-default drawer → What's-New only,
  // no coachmark target. v1.34.0 latest released → ships in 1.35.0.
  id: "learnings-promote-global",
  sinceVersion: "1.35.0",
  titleKey: "feat_learnings_promote_global_title",
  bodyKey: "feat_learnings_promote_global_body",
} satisfies FeatureAnnouncement;

export default entry;
