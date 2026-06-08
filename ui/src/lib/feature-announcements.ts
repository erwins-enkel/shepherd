// Catalog driving the What's-New drawer + first-view coachmarks.
//
// CONTRACT: every shipped user-facing feature adds ONE entry here, in the SAME
// PR as the feature — id, sinceVersion (the release it ships in), titleKey/bodyKey
// (added to BOTH ui/messages/en.json and de.json), and an optional targetId paired
// with `use:coachTarget` on the anchor element. Enforced by the
// `scripts/check-feature-catalog.sh` gate (PR-hygiene CI + pre-push).
// See CLAUDE.md → "Feature discovery (REQUIRED for user-facing features)".

export type FeatureAnnouncement = {
  id: string;
  sinceVersion: string;
  titleKey: string;
  bodyKey: string;
  targetId?: string;
};

export const featureAnnouncements: readonly FeatureAnnouncement[] = [
  {
    id: "critic",
    sinceVersion: "1.10.0",
    titleKey: "feat_critic_title",
    bodyKey: "feat_critic_body",
    targetId: "critic",
  },
  {
    id: "auto-address",
    sinceVersion: "1.10.0",
    titleKey: "feat_auto_address_title",
    bodyKey: "feat_auto_address_body",
    targetId: "auto-address",
  },
  {
    id: "learnings",
    sinceVersion: "1.10.0",
    titleKey: "feat_learnings_title",
    bodyKey: "feat_learnings_body",
    targetId: "learnings",
  },
  {
    id: "halt-the-herd",
    sinceVersion: "1.15.0",
    titleKey: "feat_halt_title",
    bodyKey: "feat_halt_body",
  },
  {
    id: "chrome-capture-extension",
    sinceVersion: "1.15.0",
    titleKey: "feature_capture_extension_title",
    bodyKey: "feature_capture_extension_body",
  },
  {
    id: "merge-train-shortcut",
    sinceVersion: "1.17.0",
    titleKey: "feat_merge_train_title",
    bodyKey: "feat_merge_train_body",
  },
  {
    // No targetId: the control lives in the Settings modal, closed by default, so a
    // coachmark anchor would rarely be mounted — surface via the What's-New drawer only.
    id: "review-cycles",
    sinceVersion: "1.17.0",
    titleKey: "feat_review_cycles_title",
    bodyKey: "feat_review_cycles_body",
  },
  {
    id: "merge-train-in-progress",
    sinceVersion: "1.17.0",
    titleKey: "feat_merge_in_progress_title",
    bodyKey: "feat_merge_in_progress_body",
  },
  {
    // No targetId: the Complete badge only appears on a session autopilot has just finished,
    // so a coachmark anchor would rarely be mounted — surface via the What's-New drawer only.
    id: "autopilot-complete",
    sinceVersion: "1.17.0",
    titleKey: "feat_autopilot_complete_title",
    bodyKey: "feat_autopilot_complete_body",
  },
  {
    // No targetId: the Readiness tab only mounts once a project is selected
    // inside the Backlog overlay, so a coachmark anchor would rarely exist —
    // surface via the What's-New drawer only.
    id: "readiness-analyzer",
    sinceVersion: "1.18.0",
    titleKey: "feat_readiness_title",
    bodyKey: "feat_readiness_body",
  },
  {
    id: "auto-merge",
    sinceVersion: "1.17.0",
    titleKey: "feat_automerge_title",
    bodyKey: "feat_automerge_body",
  },
  {
    // No targetId: the panel only mounts inside a selected session when the
    // build-queue flag is on (or a queue already exists), so a coachmark anchor
    // would rarely be mounted — surface via the What's-New drawer only.
    id: "build-queue",
    sinceVersion: "1.19.0",
    titleKey: "feat_buildqueue_title",
    bodyKey: "feat_buildqueue_body",
  },
];
