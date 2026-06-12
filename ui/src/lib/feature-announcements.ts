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
  {
    // No targetId: the version/date stamps live inside this very drawer, which is
    // not a persistent chrome anchor — surface via the What's-New drawer only.
    // 1.21.0 is already tagged, so this ships in the next release (1.22.0):
    // computeNewEntries only surfaces entries with sinceVersion > lastSeen.
    id: "whatsnew-version-date",
    sinceVersion: "1.22.0",
    titleKey: "feat_whatsnew_versiondate_title",
    bodyKey: "feat_whatsnew_versiondate_body",
  },
  {
    // No targetId: the search field only mounts once a repo with open issues is
    // selected in the Backlog view, so a coachmark anchor would usually be
    // unmounted — surface via the What's-New drawer only.
    id: "issue-search",
    sinceVersion: "1.22.0",
    titleKey: "feat_issue_search_title",
    bodyKey: "feat_issue_search_body",
  },
  {
    // No targetId: the backlog repo list only mounts on the Backlog view (not the
    // default dashboard), so a coachmark anchor would usually be unmounted —
    // surface via the What's-New drawer only.
    id: "backlog-recent-repos",
    sinceVersion: "1.22.0",
    titleKey: "feat_backlog_recent_repos_title",
    bodyKey: "feat_backlog_recent_repos_body",
  },
  {
    // No targetId: the About section lives inside the Settings modal, closed by
    // default, so a coachmark anchor would rarely be mounted — surface via the
    // What's-New drawer only. Ships in the next release (1.22.0); 1.21.0 is already
    // tagged so a 1.21.0 entry would never surface (computeNewEntries only shows
    // sinceVersion > lastSeen).
    id: "product-framing-refresh",
    sinceVersion: "1.22.0",
    titleKey: "feat_product_story_title",
    bodyKey: "feat_product_story_body",
  },
  {
    // No targetId: keyboard shortcuts are invisible chrome (documented in the
    // viewport footer hint line) — surface via the What's-New drawer only.
    id: "herd-keyboard-nav",
    sinceVersion: "1.22.0",
    titleKey: "feat_herd_keynav_title",
    bodyKey: "feat_herd_keynav_body",
  },
  {
    // Anchor lives on the DESKTOP tallies container only — the mobile compact
    // tallies are a mutually-exclusive DOM branch and coachTargets keys one node
    // per id, so on phones the coachmark simply has no anchor and the feature
    // surfaces via the What's-New drawer alone.
    // v1.21.0 is already tagged, so this ships in the next release (1.22.0).
    id: "tally-status-filter",
    sinceVersion: "1.22.0",
    titleKey: "feat_tally_filter_title",
    bodyKey: "feat_tally_filter_body",
    targetId: "tally-filter",
  },
  {
    // No targetId: the Stop button only mounts when a preview is live AND the preview
    // tab is open, so a coachmark anchor would usually be unmounted — surface via the
    // What's-New drawer only. v1.22.0 is already tagged, so this ships in the next
    // release (1.23.0): computeNewEntries only surfaces entries with sinceVersion > lastSeen.
    id: "preview-stop",
    sinceVersion: "1.23.0",
    titleKey: "feat_preview_stop_title",
    bodyKey: "feat_preview_stop_body",
  },
  {
    // No targetId: the inline emoji only mounts on cards whose repo has a
    // configured icon, so an anchor isn't guaranteed to exist — surface via the
    // What's-New drawer only. v1.22.0 is already tagged → ships in 1.23.0.
    id: "card-repo-icon-inline",
    sinceVersion: "1.23.0",
    titleKey: "feat_card_repo_icon_title",
    bodyKey: "feat_card_repo_icon_body",
  },
  {
    // No targetId: several controls changed (▶ dev-server start, AP/✓ pips, status
    // glyph); no single persistent anchor — surface via the What's-New drawer only.
    id: "slim-viewport-header",
    sinceVersion: "1.23.0",
    titleKey: "feat_slim_header_title",
    bodyKey: "feat_slim_header_body",
  },
  {
    // No targetId: the control lives inside the Settings modal (closed by default),
    // so a coachmark anchor would rarely be mounted — surface via the What's-New drawer only.
    // v1.22.0 is already tagged, so this ships in the next release (1.23.0).
    id: "default-model-setting",
    sinceVersion: "1.23.0",
    titleKey: "feat_default_model_title",
    bodyKey: "feat_default_model_body",
  },
  {
    // No targetId: the tappable emoji only mounts in the phone header and only
    // when the repo has a configured icon — surface via the What's-New drawer only.
    id: "viewport-repo-icon-inline",
    sinceVersion: "1.23.0",
    titleKey: "feat_viewport_repo_icon_title",
    bodyKey: "feat_viewport_repo_icon_body",
  },
  {
    // No targetId: keyboard shortcuts are invisible chrome (documented in the
    // viewport footer hint line) — surface via the What's-New drawer only.
    id: "herd-keynav-anywhere",
    sinceVersion: "1.23.0",
    titleKey: "feat_herd_keynav_anywhere_title",
    bodyKey: "feat_herd_keynav_anywhere_body",
  },
  {
    // No targetId: the stepper appears once per session card in a dense list — there
    // can be many steppers in the DOM simultaneously, and coachTargets keys one node
    // per id, so a duplicated targetId anchor would be wrong. Surface via the
    // What's-New drawer only.
    id: "stepper-stage-legend",
    sinceVersion: "1.23.0",
    titleKey: "feat_stepper_legend_title",
    bodyKey: "feat_stepper_legend_body",
  },
  {
    // No targetId: the hover ✕ on session-list rows is revealed on hover (not
    // persistently mounted) and the header ✕ only renders for non-PR-ready sessions,
    // so both anchors are conditionally present — surface via the What's-New drawer only.
    id: "desktop-decommission",
    sinceVersion: "1.23.0",
    titleKey: "feat_desktop_decom_title",
    bodyKey: "feat_desktop_decom_body",
  },
  {
    // No targetId: the feature is a server-sent push notification (fires when the app
    // is closed/inactive), so there is no anchor element — What's-New drawer only.
    // Bumped from 1.22.0 → 1.23.0 on merge-train rebase: 1.22.0 is already tagged, so
    // computeNewEntries (sinceVersion > lastSeen) would never surface a 1.22.0 entry.
    id: "usage-limit-push",
    sinceVersion: "1.23.0",
    titleKey: "feat_usage_limit_push_title",
    bodyKey: "feat_usage_limit_push_body",
  },
  {
    // No targetId: the issue-action buttons live on backlog issue rows (rendered only
    // when the backlog is open) and the editor inside Settings — both usually unmounted,
    // so surface via the What's-New drawer only. v1.22.0 is already tagged, so this
    // ships in the next release (1.23.0): computeNewEntries only surfaces entries with
    // sinceVersion > lastSeen.
    id: "issue-actions",
    sinceVersion: "1.23.0",
    titleKey: "feat_issue_actions_title",
    bodyKey: "feat_issue_actions_body",
  },
  {
    // No targetId: the toggle only mounts on the steer bar of a focused/selected
    // session, and there can be several steer bars in the DOM at once, so a single
    // coachmark anchor would be wrong — surface via the What's-New drawer only.
    // v1.23.0 is already tagged, so this ships in the next release (1.24.0):
    // computeNewEntries only surfaces entries with sinceVersion > lastSeen.
    id: "steer-labels-toggle",
    sinceVersion: "1.24.0",
    titleKey: "feat_steer_labels_title",
    bodyKey: "feat_steer_labels_body",
  },
  {
    // No targetId: the only armed coachmarks are the automation-pill features
    // (PILL_FEATURE_IDS in GitRail.svelte), so an anchor on the gauges would never
    // fire — this entry surfaces via the What's-New drawer alone. Fitting anyway,
    // since the detail card is a desktop-only hover affordance. On desktop, hovering
    // the top-bar usage gauges now opens a detailed card (full window names, wide
    // bars, reset times) in place of the bare one-line text tooltip. v1.23.0 is
    // already tagged, so this ships in the next release (1.24.0): computeNewEntries
    // only surfaces entries with sinceVersion > lastSeen.
    id: "usage-gauge-detail",
    sinceVersion: "1.24.0",
    titleKey: "feat_usage_gauge_detail_title",
    bodyKey: "feat_usage_gauge_detail_body",
  },
  {
    // No targetId: the popover is hover-revealed (not persistently mounted), so a
    // coachmark anchor would never exist — surface via the What's-New drawer only.
    // v1.23.0 is already tagged, so this ships in the next release (1.24.0).
    id: "tile-time-tooltip",
    sinceVersion: "1.24.0",
    titleKey: "feat_time_tooltip_title",
    bodyKey: "feat_time_tooltip_body",
  },
  {
    // targetId "newproject-row" matches the use:coachTarget id on the "+ New project"
    // row in RepoSelect.svelte. 1.23.0 is already tagged, so this ships in 1.24.0:
    // computeNewEntries only surfaces entries with sinceVersion > lastSeen.
    id: "new-project-from-shepherd",
    sinceVersion: "1.24.0",
    titleKey: "feat_new_project_title",
    bodyKey: "feat_new_project_body",
    targetId: "newproject-row",
  },
  {
    // No targetId — the collapse chevron only mounts on unfolded-fold / touch-wide
    // layouts, so a coachmark anchor would rarely exist — surface via the What's-New
    // drawer only. v1.24.0 is already tagged, so this ships in the next release (1.25.0).
    id: "sidebar-collapse",
    sinceVersion: "1.25.0",
    titleKey: "feat_sidebar_collapse_title",
    bodyKey: "feat_sidebar_collapse_body",
  },
  {
    // No targetId: the herdr update modal is only mounted while open (and only when an
    // update is available), so a coachmark anchor would rarely exist — surface via the
    // What's-New drawer only. v1.24.0 is already tagged, so this ships in 1.25.0.
    id: "herdr-release-notes-link",
    sinceVersion: "1.25.0",
    titleKey: "feat_herdr_release_notes_link_title",
    bodyKey: "feat_herdr_release_notes_link_body",
  },
  {
    // No targetId: the chip rail only renders when ≥2 repos have a live session, so a
    // coachmark anchor would often be unmounted. Surface via the What's-New drawer only
    // (same rationale as the prior "repo-status-filter" entry it supersedes).
    id: "repo-switcher",
    sinceVersion: "1.25.0",
    titleKey: "feat_repo_switcher_title",
    bodyKey: "feat_repo_switcher_body",
  },
  {
    // No targetId: only the automation-pill coachmarks are armed (PILL_FEATURE_IDS
    // in GitRail.svelte), so an anchor on the header button would never fire —
    // surface via the What's-New drawer only. v1.24.0 is already tagged, so this
    // ships in the next release (1.25.0).
    id: "viewport-redraw-menu",
    sinceVersion: "1.25.0",
    titleKey: "feat_redraw_menu_title",
    bodyKey: "feat_redraw_menu_body",
  },
  {
    // targetId "adopt-gitignore" matches the use:coachTarget id on the adopt button
    // in ReadinessPanel.svelte (mounts on the Backlog Readiness tab). 1.25.0 is
    // already released, so this ships in 1.26.0: computeNewEntries only surfaces
    // entries with sinceVersion > lastSeen.
    id: "adopt-gitignore",
    sinceVersion: "1.26.0",
    titleKey: "feat_adopt_gitignore_title",
    bodyKey: "feat_adopt_gitignore_body",
    targetId: "adopt-gitignore",
  },
  {
    // No targetId: the badges live on backlog repo-list rows (only mounted on the
    // Backlog view) and the list scrolls, so a coachmark anchor would often be
    // unmounted — surface via the What's-New drawer only. 1.25.0 is already
    // released, so this ships in 1.26.0: computeNewEntries only surfaces entries
    // with sinceVersion > lastSeen.
    id: "pr-kind-badges",
    sinceVersion: "1.26.0",
    titleKey: "feat_pr_kind_badges_title",
    bodyKey: "feat_pr_kind_badges_body",
  },
  {
    // No targetId: the backlog repo list only mounts on the Backlog view (not the
    // default dashboard), so a coachmark anchor would usually be unmounted —
    // surface via the What's-New drawer only.
    id: "backlog-repo-search",
    sinceVersion: "1.26.0",
    titleKey: "feat_backlog_repo_search_title",
    bodyKey: "feat_backlog_repo_search_body",
  },
  {
    // No targetId: the control lives in a card's right-click / long-press context
    // menu, not a fixed anchor, so a coachmark anchor would rarely be mounted —
    // surface via the What's-New drawer only. Ships in 1.26.0 (1.25.0 just shipped).
    id: "relaunch-task",
    sinceVersion: "1.26.0",
    titleKey: "feat_relaunch_title",
    bodyKey: "feat_relaunch_body",
  },
  {
    // No targetId: only the automation-pill coachmarks are armed (PILL_FEATURE_IDS
    // in GitRail.svelte), so an anchor on the header title would never fire —
    // surface via the What's-New drawer only. v1.26.0 is already released, so this
    // ships in the next release (1.27.0): computeNewEntries only surfaces entries
    // with sinceVersion > lastSeen.
    id: "title-rename-shortcut",
    sinceVersion: "1.27.0",
    titleKey: "feat_title_rename_title",
    bodyKey: "feat_title_rename_body",
  },
  {
    // No targetId: the pencil only mounts on the steer bar (focused-session view) and
    // only when the bar isn't crowded — on mobile/overflow the ABC toggle takes the
    // slot — so a coachmark anchor would often be absent. Surface via the What's-New
    // drawer only. 1.26.0 is already released, so this ships in 1.27.0.
    id: "steerbar-edit",
    sinceVersion: "1.27.0",
    titleKey: "feat_steerbar_edit_title",
    bodyKey: "feat_steerbar_edit_body",
  },
  {
    // context-menu control, no fixed anchor → What's-New drawer only
    id: "relaunch-different-repo",
    sinceVersion: "1.27.0",
    titleKey: "feat_relaunch_repo_title",
    bodyKey: "feat_relaunch_repo_body",
  },
  {
    // 1.27.0 is already released, so this ships in 1.28.0 (next minor) — else a
    // 1.27.0 entry would never surface for users who already saw the 1.27.x drawer.
    id: "sandbox-profiles",
    sinceVersion: "1.28.0",
    titleKey: "feat_sandbox_title",
    bodyKey: "feat_sandbox_body",
    targetId: "sandbox-profile",
  },
  {
    // No targetId: the Epic panel only mounts when a session is actively running an
    // epic (a tracking-issue link is set), so a coachmark anchor would rarely exist —
    // surface via the What's-New drawer only. 1.27.0 is already released, so this
    // ships in 1.28.0: computeNewEntries only surfaces entries with sinceVersion > lastSeen.
    id: "epic-runner",
    sinceVersion: "1.28.0",
    titleKey: "feat_epic_runner_title",
    bodyKey: "feat_epic_runner_body",
  },
  {
    // No targetId: the badge is per-row/dynamic — there's no single stable anchor
    // for a coachmark. Surface via the What's-New drawer only.
    id: "native-sub-issues",
    sinceVersion: "1.28.0",
    titleKey: "feat_native_sub_issues_title",
    bodyKey: "feat_native_sub_issues_body",
  },
  {
    // No targetId: the EPIC badge is list-repeated (one per epic-seeded session row), but
    // coachTargets keys a single node per id — multiple badges would collide on one key and
    // any row's unmount would delete the shared anchor. There's no single stable element to
    // point at, so surface via the What's-New drawer only (same as epic-runner).
    // v1.27.0 is the latest released tag, so this ships in 1.28.0 — computeNewEntries only
    // surfaces entries with sinceVersion > lastSeen.
    id: "session-epic-badge",
    sinceVersion: "1.28.0",
    titleKey: "feat_session_epic_badge_title",
    bodyKey: "feat_session_epic_badge_body",
  },
];
