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
    sinceVersion: "1.20.0",
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
    sinceVersion: "1.18.0",
    titleKey: "feat_buildqueue_title",
    bodyKey: "feat_buildqueue_body",
  },
  {
    id: "plan-gate",
    sinceVersion: "1.19.0",
    titleKey: "feat_plan_gate_title",
    bodyKey: "feat_plan_gate_body",
    targetId: "plan-gate",
  },
  {
    id: "backlog-repo-filter",
    sinceVersion: "1.19.0",
    titleKey: "feat_backlog_repo_filter_title",
    bodyKey: "feat_backlog_repo_filter_body",
  },
  {
    id: "new-task-repo-first",
    sinceVersion: "1.19.0",
    titleKey: "feat_newtask_repo_first_title",
    bodyKey: "feat_newtask_repo_first_body",
    targetId: "nt-repo",
  },
  {
    // No targetId: the multi-select controls live inside the PRs tab which is
    // only mounted when a repo is selected; coachmark anchor added in a later task.
    id: "backlog-pr-merge-train",
    // v1.19.0 is already tagged, so this feature ships in the next release (1.20.0).
    // computeNewEntries only surfaces entries with lastSeen < sinceVersion, so a
    // 1.19.0 entry would never reach users who already saw the 1.19.0 drawer.
    sinceVersion: "1.20.0",
    titleKey: "feat_backlog_pr_merge_train_title",
    bodyKey: "feat_backlog_pr_merge_train_body",
  },
  {
    // No targetId: the fold chevron only mounts on the compact/mobile layout, so a
    // coachmark anchor would rarely be present on first view — surface via the
    // What's-New drawer only.
    id: "header-fold",
    sinceVersion: "1.20.0",
    titleKey: "feat_header_fold_title",
    bodyKey: "feat_header_fold_body",
  },
  {
    // No targetId: the repo-status band only renders when a repo has an active drain
    // or pending learnings, so a coachmark anchor would often be unmounted — surface
    // via the What's-New drawer only.
    id: "learnings-per-repo",
    sinceVersion: "1.20.0",
    titleKey: "feat_learnings_per_repo_title",
    bodyKey: "feat_learnings_per_repo_body",
  },
];
