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

/** The catalog id for the Fable 5 launch. When this entry is "new" for an
 *  upgrading user, +page.svelte fires the one-time FableArrival celebration
 *  in addition to listing it in the What's-New drawer. */
export const FABLE_FEATURE_ID = "fable-5";

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
  {
    // The offer surfaces as a transient post-merge toast (no persistent anchor
    // element to point a coachmark at), so What's-New drawer only — no targetId.
    id: "update-local-checkout-after-merge",
    sinceVersion: "1.20.0",
    titleKey: "feat_update_checkout_title",
    bodyKey: "feat_update_checkout_body",
  },
  {
    // No targetId: the "ⓘ" buttons live inside the automation popover, which is
    // closed by default, so a coachmark anchor would rarely be mounted — surface
    // via the What's-New drawer only.
    id: "automation-help-icons",
    sinceVersion: "1.20.0",
    titleKey: "feat_automation_help_title",
    bodyKey: "feat_automation_help_body",
  },
  {
    // No targetId: the critic badge only renders while a PR critic is actively reviewing,
    // so a coachmark anchor would rarely be mounted — surface via the What's-New drawer only.
    id: "critic-live-activity",
    sinceVersion: "1.20.0",
    titleKey: "feat_critic_activity_title",
    bodyKey: "feat_critic_activity_body",
  },
  {
    // No targetId: the Preview badge only renders when a dev-server port is detected in the
    // agent's worktree, so a coachmark anchor would rarely be mounted — surface via the
    // What's-New drawer only.
    id: "live-preview",
    sinceVersion: "1.20.0",
    titleKey: "feat_preview_title",
    bodyKey: "feat_preview_body",
  },
  {
    // No targetId: the roles controls live in the automation popover, closed by
    // default, so a coachmark anchor would rarely be mounted — surface via the
    // What's-New drawer only.
    id: "repo-roles",
    sinceVersion: "1.20.0",
    titleKey: "feat_repo_roles_title",
    bodyKey: "feat_repo_roles_body",
  },
  {
    // No targetId: the highlighted chip only renders on issues currently claimed by a
    // Shepherd agent, so a coachmark anchor would rarely be mounted — surface via the
    // What's-New drawer only.
    id: "backlog-active-highlight",
    sinceVersion: "1.20.0",
    titleKey: "feat_backlog_active_highlight_title",
    bodyKey: "feat_backlog_active_highlight_body",
  },
  {
    // No targetId: the nudge is a timed bottom-left card that only appears after a
    // few days of use, not a persistent chrome element — surface via the What's-New
    // drawer only.
    id: "github-star",
    sinceVersion: "1.20.0",
    titleKey: "feat_star_title",
    bodyKey: "feat_star_body",
  },
  {
    // No targetId: the repo-status band only renders when a repo has an active drain
    // or pending learnings, so a coachmark anchor would often be unmounted — surface
    // via the What's-New drawer only.
    id: "repo-status-filter",
    sinceVersion: "1.20.0",
    titleKey: "feat_repo_filter_title",
    bodyKey: "feat_repo_filter_body",
  },
  {
    // No targetId: the Resume button + card menu only appear on a parked (idle/done)
    // session, so a coachmark anchor would rarely be mounted — surface via the
    // What's-New drawer only.
    id: "resume-parked-session",
    sinceVersion: "1.20.0",
    titleKey: "feat_resume_session_title",
    bodyKey: "feat_resume_session_body",
  },
  {
    id: "draft-mode",
    sinceVersion: "1.20.0",
    titleKey: "feat_draft_mode_title",
    bodyKey: "feat_draft_mode_body",
    targetId: "draft-mode",
  },
  {
    // No targetId: the Start control only renders on an agent with no bound preview port,
    // so a coachmark anchor would rarely be mounted — surface via the What's-New drawer only.
    id: "preview-start",
    sinceVersion: "1.20.0",
    titleKey: "feat_preview_start_title",
    bodyKey: "feat_preview_start_body",
  },
  {
    // No targetId: the New Task prompt-sources issue list only mounts inside the open
    // New Task dialog, so a coachmark anchor would usually be unmounted — surface via
    // the What's-New drawer only.
    id: "active-label-newtask",
    sinceVersion: "1.21.0",
    titleKey: "feat_active_label_newtask_title",
    bodyKey: "feat_active_label_newtask_body",
  },
  {
    // No targetId: the recent-repos group only mounts inside the open repo picker
    // dropdown in New Task, so a coachmark anchor would usually be unmounted —
    // surface via the What's-New drawer only.
    id: "recent-repos-pinned",
    sinceVersion: "1.21.0",
    titleKey: "feat_recent_repos_title",
    bodyKey: "feat_recent_repos_body",
  },
  {
    // No targetId: the model picker lives in the New Task dialog (closed by default).
    // Beyond this drawer line, an upgrading user also gets the one-time FableArrival
    // celebration overlay — see FABLE_FEATURE_ID + FableArrival.svelte.
    // v1.20.0 is already tagged, so this ships in the next release (1.21.0):
    // computeNewEntries only surfaces entries with sinceVersion > lastSeen.
    id: FABLE_FEATURE_ID,
    sinceVersion: "1.21.0",
    titleKey: "feat_fable_title",
    bodyKey: "feat_fable_body",
  },
  {
    // No targetId: operator-facing infra (zero manual tailscale serve setup); the only
    // UI trace is a degraded Preview badge on failure — surface via the What's-New drawer only.
    // Ships in the next release (1.21.0); 1.20.0 is already tagged so a 1.20.0 entry
    // would never surface (computeNewEntries only shows sinceVersion > lastSeen).
    id: "preview-tailscale-auto",
    sinceVersion: "1.21.0",
    titleKey: "feat_preview_tailscale_title",
    bodyKey: "feat_preview_tailscale_body",
  },
];
