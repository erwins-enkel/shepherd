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
  {
    // No targetId: the guardrail row only mounts on the Backlog Readiness tab once a
    // project is selected, so a coachmark anchor would usually be unmounted — surface
    // via the What's-New drawer only.
    id: "readiness-dependency-automation",
    sinceVersion: "1.28.0",
    titleKey: "feat_dependency_automation_title",
    bodyKey: "feat_dependency_automation_body",
  },
  {
    // No targetId: the chip is per-row/dynamic (only on PRs targeting a non-default
    // branch) — there's no single stable anchor for a coachmark. Surface via the
    // What's-New drawer only.
    id: "pr-target-branch",
    sinceVersion: "1.28.0",
    titleKey: "feat_pr_target_branch_title",
    bodyKey: "feat_pr_target_branch_body",
  },
  {
    // No targetId: epic groups only render when an active epic has ≥1 child session,
    // so the headline anchor isn't reliably present — surface via the What's-New drawer
    // only. v1.27.0 is the latest released tag, so this ships in 1.28.0.
    id: "epic-session-grouping",
    sinceVersion: "1.28.0",
    titleKey: "feat_epic_grouping_title",
    bodyKey: "feat_epic_grouping_body",
  },
  {
    // No targetId: the toggle lives inside the AutomationPanel popover (closed by
    // default), so a coachmark anchor would rarely be mounted — surface via the
    // What's-New drawer only. 1.27.0 is already released, so this ships in 1.28.0:
    // computeNewEntries only surfaces entries with sinceVersion > lastSeen.
    id: "standalone-pr-critic",
    sinceVersion: "1.28.0",
    titleKey: "feat_critic_all_prs_title",
    bodyKey: "feat_critic_all_prs_body",
  },
  {
    // No targetId: the steers editor lives inside Settings (closed by default), so a
    // coachmark anchor would rarely be mounted — surface via the What's-New drawer
    // only. 1.27.0 is already released, so this ships in 1.28.0.
    id: "steers-prompt-slash-commands",
    sinceVersion: "1.28.0",
    titleKey: "feat_steers_prompt_editor_title",
    bodyKey: "feat_steers_prompt_editor_body",
  },
  {
    // No targetId: the picker lives inside the AutomationPanel popover (closed by
    // default), so a coachmark anchor would rarely be mounted — surface via the
    // What's-New drawer only. 1.27.0 is already released, so this ships in 1.28.0.
    id: "repo-default-model",
    sinceVersion: "1.28.0",
    titleKey: "feat_repo_default_model_title",
    bodyKey: "feat_repo_default_model_body",
  },
  {
    // No targetId: the CR credit gauge only mounts when paid extra usage is enabled
    // (limits.credits present), so a coachmark anchor would usually be absent —
    // surface via the What's-New drawer only. 1.27.0 is the latest released tag, so
    // this ships in 1.28.0: computeNewEntries only surfaces sinceVersion > lastSeen.
    id: "extra-credits-gauge",
    sinceVersion: "1.28.0",
    titleKey: "feat_extra_credits_title",
    bodyKey: "feat_extra_credits_body",
  },
  {
    // No targetId: the egress badge only renders on autonomous sessions and the
    // egress-drop toast fires transiently — no persistent anchor element to point a
    // coachmark at. Surface via the What's-New drawer only.
    id: "network-egress-allowlist",
    sinceVersion: "1.28.0",
    titleKey: "feat_egress_title",
    bodyKey: "feat_egress_body",
  },
  {
    // No targetId: the toggle lives on the Settings → Device tab (modal closed by
    // default), so a coachmark anchor would rarely be mounted — surface via the
    // What's-New drawer only. 1.27.0 is the latest released tag, so this ships in 1.28.0.
    id: "mobile-high-contrast",
    sinceVersion: "1.28.0",
    titleKey: "feat_mobile_contrast_title",
    bodyKey: "feat_mobile_contrast_body",
  },
  {
    // targetId "diagnostics" matches the use:coachTarget id on the TopBar health
    // pip, so the coachmark points at it. 1.27.0 is the latest released tag, so
    // this ships in 1.28.0: computeNewEntries only surfaces sinceVersion > lastSeen.
    id: "diagnostics",
    sinceVersion: "1.28.0",
    titleKey: "feat_diagnostics_title",
    bodyKey: "feat_diagnostics_body",
    targetId: "diagnostics",
  },
  {
    // targetId "session-recap" matches use:coachTarget on the recap card root in
    // SessionRecap.svelte, so the coachmark can point at it.
    id: "session-recap",
    sinceVersion: "1.29.0",
    titleKey: "feat_session_recap_title",
    bodyKey: "feat_session_recap_body",
    targetId: "session-recap",
  },
  {
    // No targetId: the research toggle lives on the New Task sheet (a modal closed by
    // default), so a coachmark anchor would rarely be mounted — surface via What's-New only.
    // 1.28.0 is the latest released tag, so this ships in 1.29.0.
    id: "research-task",
    sinceVersion: "1.29.0",
    titleKey: "feat_research_title",
    bodyKey: "feat_research_body",
  },
  {
    // No targetId: the band only mounts when there are completed epics, so a
    // coachmark anchor would usually be absent — surface via the What's-New drawer
    // only. 1.28.0 is the latest released tag, so this ships in 1.29.0.
    id: "integrated-epics-band",
    sinceVersion: "1.29.0",
    titleKey: "feat_integrated_epics_title",
    bodyKey: "feat_integrated_epics_body",
  },
  {
    // No targetId: the toggle lives in the Settings modal DEVICE tab (closed by
    // default), so a coachmark anchor would rarely be mounted — surface via the
    // What's-New drawer only. v1.28.0 is already released, so this ships in 1.29.0:
    // computeNewEntries surfaces entries where lastSeen < sinceVersion <= current app version.
    id: "colorblind-status-markers",
    sinceVersion: "1.29.0",
    titleKey: "feat_colorblind_markers_title",
    bodyKey: "feat_colorblind_markers_body",
  },
  {
    // No targetId: the controls live inside the gear menu (closed by default) and the
    // feature is mobile-only, so a desktop coachmark anchor would mislead — surface via
    // the What's-New drawer only. 1.29.0 is the latest released tag, so this ships in 1.30.0.
    id: "quick-theme-controls",
    sinceVersion: "1.30.0",
    titleKey: "feat_quick_theme_title",
    bodyKey: "feat_quick_theme_body",
  },
  {
    // No targetId: the band only mounts when there are completed epics, and the
    // landing-PR link only appears once the aggregate PR is open, so a coachmark
    // anchor would usually be absent — surface via the What's-New drawer only.
    // 1.29.0 is the latest released tag, so this ships in 1.30.0: computeNewEntries
    // only surfaces entries with sinceVersion > lastSeen.
    id: "epic-landing-pr",
    sinceVersion: "1.30.0",
    titleKey: "feat_epic_landing_pr_title",
    bodyKey: "feat_epic_landing_pr_body",
  },
  {
    // No targetId: the Diagnostics tab lives inside the Settings modal (closed by
    // default), so a coachmark anchor would rarely be mounted — What's-New drawer only.
    // 1.29.0 is the latest released tag, so this ships in 1.30.0.
    id: "pwa-install-diagnostic",
    sinceVersion: "1.30.0",
    titleKey: "feat_pwa_install_title",
    bodyKey: "feat_pwa_install_body",
  },
  {
    // The DONE filter button lives in the always-visible Herd header, so a coachmark
    // anchor is reliably mounted — point at it via targetId + use:coachTarget.
    id: "done-lens",
    sinceVersion: "1.30.0",
    titleKey: "feat_done_lens_title",
    bodyKey: "feat_done_lens_body",
    targetId: "done-lens",
  },
  {
    // No targetId: the toggle lives in the Settings modal SESSION tab (closed by default),
    // so a coachmark anchor would rarely be mounted — surface via the What's-New drawer only.
    // 1.29.0 is the latest released tag, so this ships in 1.30.0.
    id: "api-key-auth",
    sinceVersion: "1.30.0",
    titleKey: "feat_api_key_auth_title",
    bodyKey: "feat_api_key_auth_body",
  },
  {
    // No targetId: command links appear inline in the terminal output, which has no
    // stable mountable anchor — surface via the What's-New drawer only.
    // 1.29.0 is the latest released tag, so this ships in 1.30.0.
    id: "tappable-slash-commands",
    sinceVersion: "1.30.0",
    titleKey: "feat_tappable_slash_commands_title",
    bodyKey: "feat_tappable_slash_commands_body",
  },
  {
    // No targetId: the Verify button only mounts in the Settings modal SESSION tab
    // (closed by default) and only once an API key is configured, so a coachmark
    // anchor would rarely be mounted — surface via the What's-New drawer only.
    id: "api-key-verify",
    sinceVersion: "1.30.0",
    titleKey: "feat_api_key_verify_title",
    bodyKey: "feat_api_key_verify_body",
  },
  {
    // No targetId: the prescription lives in the Backlog → Readiness panel's
    // generated-snippet block (Copy / Send-to-task), several clicks deep — surface
    // via the What's-New drawer only. 1.29.0 is the latest released tag, so this
    // ships in 1.30.0.
    id: "readiness-install-commands",
    sinceVersion: "1.30.0",
    titleKey: "feat_readiness_install_commands_title",
    bodyKey: "feat_readiness_install_commands_body",
  },
  {
    // No targetId: the link lives inside the gear menu (closed by default) and is
    // mobile-only, so a desktop coachmark anchor would mislead — surface via the
    // What's-New drawer only. 1.30.0 is the latest released tag, so this ships in 1.31.0.
    id: "mobile-menu-docs-version",
    sinceVersion: "1.31.0",
    titleKey: "feat_mobile_menu_docs_title",
    bodyKey: "feat_mobile_menu_docs_body",
  },
  {
    // No targetId: the migration chip only appears on a completed-epic row whose landing PR
    // carries migration files, so a coachmark anchor would usually be absent — surface via the
    // What's-New drawer only. 1.29.0 is the latest released tag, so this ships in 1.30.0.
    id: "epic-migration-checkpoint",
    sinceVersion: "1.30.0",
    titleKey: "feat_epic_migrations_title",
    bodyKey: "feat_epic_migrations_body",
  },
  {
    // No targetId: the owner picker only mounts inside the New-project dialog (closed by
    // default) and only after the GitHub box is checked, so a coachmark anchor would
    // rarely be present — surface via the What's-New drawer only. 1.30.0 is the latest
    // released tag, so this ships in 1.31.0.
    id: "newproject-github-owner",
    sinceVersion: "1.31.0",
    titleKey: "feat_newproject_owner_title",
    bodyKey: "feat_newproject_owner_body",
  },
  {
    // targetId "fork-row" anchors the coachmark on the "Fork a GitHub repo" trigger
    // in the repo picker (RepoSelect). 1.30.0 is the latest released tag, so this
    // ships in 1.31.0.
    id: "fork-repo",
    sinceVersion: "1.31.0",
    titleKey: "feat_fork_repo_title",
    bodyKey: "feat_fork_repo_body",
    targetId: "fork-row",
  },
  {
    // No targetId: the ⟲ Sync button only renders on fork rows inside the repo
    // picker (RepoSelect), which is closed by default — a coachmark anchor would
    // usually be unmounted, so surface via the What's-New drawer only. 1.31.0 is the
    // latest released tag (the fork-repo feature above), so this ships in 1.32.0.
    id: "fork-sync",
    sinceVersion: "1.32.0",
    titleKey: "feat_fork_sync_title",
    bodyKey: "feat_fork_sync_body",
  },
  {
    // No targetId: the countdown surfaces in the hover tooltip and hover/tap popovers
    // of the TopBar usage gauges; there is no single persistent anchor element to
    // point a coachmark at. Surface via the What's-New drawer only. 1.32.0 is the
    // latest released tag, so this ships in 1.33.0.
    id: "usage-reset-countdown",
    sinceVersion: "1.33.0",
    titleKey: "feat_usage_reset_countdown_title",
    bodyKey: "feat_usage_reset_countdown_body",
  },
  {
    // No targetId: the link is inline in the panel header (only rendered when a repo is
    // selected in the Backlog view), so a coachmark anchor would usually be unmounted —
    // surface via the What's-New drawer only. 1.30.0 is the latest released tag, so this
    // ships in 1.31.0: computeNewEntries only surfaces entries with sinceVersion > lastSeen.
    id: "backlog-repo-forge-link",
    sinceVersion: "1.31.0",
    titleKey: "feat_backlog_repo_link_title",
    bodyKey: "feat_backlog_repo_link_body",
  },
  {
    // No targetId: glossary terms are list-repeated inline across What's-New and coachmark
    // body text — there is no single stable anchor element to point a coachmark at (same
    // rationale as session-epic-badge and backlog-repo-filter). Surface via the What's-New
    // drawer only. 1.29.0 is the latest released tag, so this ships in 1.30.0.
    id: "glossary-tooltips",
    sinceVersion: "1.30.0",
    titleKey: "feat_glossary_title",
    bodyKey: "feat_glossary_body",
  },
  {
    // targetId "task-autopilot" anchors the coachmark on the per-task Autopilot
    // checkbox in the New Task dialog. 1.31.0 is the latest released tag, so this
    // ships in 1.32.0.
    id: "task-autopilot-override",
    sinceVersion: "1.32.0",
    titleKey: "feat_task_autopilot_title",
    bodyKey: "feat_task_autopilot_body",
    targetId: "task-autopilot",
  },
  {
    // targetId "task-autopilot" anchors the coachmark on the Autopilot row in the New
    // Task dialog, where the new "i" tooltips and the repo-default badge live. 1.31.0
    // is the latest released tag, so this ships in 1.32.0.
    id: "newtask-option-infotips",
    sinceVersion: "1.32.0",
    titleKey: "feat_newtask_infotips_title",
    bodyKey: "feat_newtask_infotips_body",
    targetId: "task-autopilot",
  },
  {
    // No targetId: the Fix button lives in the Settings → Diagnostics tab (modal closed
    // by default), so a coachmark anchor would rarely be mounted — surface via the
    // What's-New drawer only (same as the prior "diagnostics"/"pwa-install-diagnostic"
    // entries). 1.31.0 is the latest released tag, so this ships in 1.32.0.
    id: "diagnose-one-click-fix",
    sinceVersion: "1.32.0",
    titleKey: "feat_diagnose_fix_title",
    bodyKey: "feat_diagnose_fix_body",
  },
  {
    // No targetId: the doc-links live in the Settings → Diagnostics tab (modal closed
    // by default), so surface via the What's-New drawer only, like the prior
    // "diagnose-one-click-fix" entry. 1.31.0 is the latest released tag → ships in 1.32.0.
    id: "diagnose-doc-links",
    sinceVersion: "1.32.0",
    titleKey: "feat_diagnose_doc_links_title",
    bodyKey: "feat_diagnose_doc_links_body",
  },
  {
    // targetId "herd-rundown" anchors the coachmark on the left-list RUNDOWN filter
    // tab (Herd.svelte desktop fbtn). The tab is unmounted when the sidebar is
    // collapsed, so the coachmark degrades to drawer-only in that case. 1.31.0 is
    // the latest released tag, so this ships in 1.32.0.
    id: "herd-rundown",
    sinceVersion: "1.32.0",
    titleKey: "feat_herd_rundown_title",
    bodyKey: "feat_herd_rundown_body",
    targetId: "herd-rundown",
  },
  {
    // targetId "subagent-fanout" anchors the coachmark on the fan-out section in
    // the Activity tab. 1.31.0 is the latest released tag, so this ships in 1.32.0.
    id: "subagent-fanout",
    sinceVersion: "1.32.0",
    titleKey: "feat_subagent_fanout_title",
    bodyKey: "feat_subagent_fanout_body",
    targetId: "subagent-fanout",
  },
  {
    // The clone dialog now lists every GitHub repo you can reach (your own account +
    // the orgs/teams you belong to) and clones the picked one directly. 1.32.0 is the
    // latest released tag, so this ships in 1.33.0.
    id: "clone-repo-picker",
    sinceVersion: "1.33.0",
    titleKey: "feat_clone_repo_picker_title",
    bodyKey: "feat_clone_repo_picker_body",
  },
  {
    // targetId "manual-critic-review" anchors the coachmark on the Review/Re-review
    // button on the PR rail (GitRail), shown for open PRs with green CI + critic on.
    // 1.32.0 is the latest released tag, so this ships in 1.33.0.
    id: "manual-critic-review",
    sinceVersion: "1.33.0",
    titleKey: "feat_manual_critic_review_title",
    bodyKey: "feat_manual_critic_review_body",
    targetId: "manual-critic-review",
  },
  {
    // No targetId: the only <Coachmark> host (GitRail) arms exclusively over
    // PILL_FEATURE_IDS, and WhatsNew surfaces entries by text. An anchored coachmark
    // would never fire (and the Review-plan button is anyway unmounted on desktop
    // until the git disclosure expands, and only exists while planPhase==="planning").
    // Discovery is via the What's-New drawer.
    id: "manual-plan-review",
    sinceVersion: "1.33.0",
    titleKey: "feat_manual_plan_review_title",
    bodyKey: "feat_manual_plan_review_body",
  },
  {
    id: "quota-needs-you",
    sinceVersion: "1.33.0",
    titleKey: "feat_quota_needs_you_title",
    bodyKey: "feat_quota_needs_you_body",
  },
  {
    // targetId "mobile-seg-ctrl" anchors the coachmark on the segmented control
    // wrapper in the Herd header (flow/mobile mode). 1.33.0 is the latest released
    // tag, so this ships in 1.34.0.
    id: "mobile-header-declutter",
    sinceVersion: "1.34.0",
    titleKey: "feat_mobile_header_title",
    bodyKey: "feat_mobile_header_body",
    targetId: "mobile-seg-ctrl",
  },
  {
    // targetId "nt-repo" anchors the coachmark on the New Task repo field
    // (use:coachTarget={"nt-repo"}). 1.33.0 is the latest released tag, so this
    // ships in 1.34.0.
    id: "repo-switch-shortcuts",
    sinceVersion: "1.34.0",
    titleKey: "feat_repo_shortcuts_title",
    bodyKey: "feat_repo_shortcuts_body",
    targetId: "nt-repo",
  },
  {
    // No targetId: the freshen happens at task-launch time (no persistent anchor
    // element) and the New Task behind/diverged hint lives inside the New Task dialog
    // (closed by default) — surface via the What's-New drawer only. 1.33.0 is the
    // latest released tag, so this ships in 1.34.0.
    id: "base-freshen",
    sinceVersion: "1.34.0",
    titleKey: "feat_base_freshen_title",
    bodyKey: "feat_base_freshen_body",
  },
  {
    // targetId "build-queue-collapse" anchors the coachmark on the collapse toggle
    // button in the BuildQueuePanel header. The panel only mounts when the build-queue
    // flag is on (or a queue exists), but the button is always mounted while the panel
    // is visible. 1.33.0 is the latest released tag, so this ships in 1.34.0.
    id: "build-queue-collapse",
    sinceVersion: "1.34.0",
    titleKey: "feat_build_queue_collapse_title",
    bodyKey: "feat_build_queue_collapse_body",
    targetId: "build-queue-collapse",
  },
  {
    // coachTarget "build-queue-progress" is on the BuildQueueBadge span itself
    // (conditionally rendered when approved + steps > 0). 1.33.0 is the latest
    // released tag, so this ships in 1.34.0.
    id: "build-queue-progress",
    sinceVersion: "1.34.0",
    titleKey: "feat_build_queue_progress_title",
    bodyKey: "feat_build_queue_progress_body",
    targetId: "build-queue-progress",
  },
  {
    // No targetId: the filter toggle only renders when flagged rules exist, so there's no
    // stable anchor; surface via the What's-New drawer only. 1.33.0 is the latest released
    // tag, so this ships in 1.34.0.
    id: "optimize-not-working-learnings",
    sinceVersion: "1.34.0",
    titleKey: "feat_optimize_learnings_title",
    bodyKey: "feat_optimize_learnings_body",
  },
  {
    // targetId "session-recap" anchors the coachmark on the live SessionRecap card
    // (use:coachTarget={"session-recap"} in SessionRecap.svelte). 1.33.0 is the latest
    // released tag, so this ships in 1.34.0.
    id: "visual-recap-blocks",
    sinceVersion: "1.34.0",
    titleKey: "feat_visual_recap_title",
    bodyKey: "feat_visual_recap_body",
    targetId: "session-recap",
  },
  {
    // targetId "session-recap" anchors the coachmark on the live SessionRecap card.
    // Extends Phase 1 visual recaps with six new card types: code, annotated-code,
    // data-model, api-endpoint, table, checklist. 1.33.0 is the latest released tag,
    // so this ships in 1.34.0.
    id: "visual-recap-cards",
    sinceVersion: "1.34.0",
    titleKey: "feat_visual_recap_cards_title",
    bodyKey: "feat_visual_recap_cards_body",
    targetId: "session-recap",
  },
  {
    // Extends visual recaps (Phase 3) with rendered Mermaid architecture/flow diagrams.
    // 1.33.0 is the latest released tag, so this ships in 1.34.0.
    id: "visual-recap-diagrams",
    sinceVersion: "1.34.0",
    titleKey: "feat_visual_recap_diagrams_title",
    bodyKey: "feat_visual_recap_diagrams_body",
    targetId: "session-recap",
  },
  {
    id: "visual-recap-wireframes",
    sinceVersion: "1.34.0",
    titleKey: "feat_visual_recap_wireframes_title",
    bodyKey: "feat_visual_recap_wireframes_body",
    targetId: "session-recap",
  },
  {
    // No targetId: the triage band, over-budget meter, and header filters all render conditionally
    // (only when a repo needs attention), so there's no stable anchor element; surface via the
    // What's-New drawer only. 1.33.0 is the latest released tag, so this ships in 1.34.0.
    id: "learnings-triage-layer",
    sinceVersion: "1.34.0",
    titleKey: "feat_learnings_triage_title",
    bodyKey: "feat_learnings_triage_body",
  },
  {
    // No targetId: PlanPanel is an on-demand modal (closed by default), so there's no
    // stable always-visible anchor for a coachmark — surface via the What's-New drawer
    // only. 1.33.0 is the latest released tag, so this ships in 1.34.0.
    id: "native-visual-plans",
    sinceVersion: "1.34.0",
    titleKey: "feat_visual_plan_title",
    bodyKey: "feat_visual_plan_body",
  },
  {
    // The plan question-form is now answerable in-UI: pick options / type freeform and the
    // answers steer back into the planning agent. No targetId — PlanPanel is an on-demand
    // modal with no stable always-visible anchor. v1.34.0 is the latest tag → ships in 1.35.0.
    id: "plan-question-answers",
    sinceVersion: "1.35.0",
    titleKey: "feat_plan_question_answers_title",
    bodyKey: "feat_plan_question_answers_body",
  },
  {
    // The Activity tab now renders a deterministic live visual feed (file-tree from the
    // diff + a kind-sectioned tool stream) and graduates to the full visual recap once
    // the session settles. v1.34.0 is the latest released tag → ships in 1.35.0.
    id: "activity-visual-feed",
    sinceVersion: "1.35.0",
    titleKey: "feat_activity_visual_feed_title",
    bodyKey: "feat_activity_visual_feed_body",
    targetId: "activity-tab",
  },
  {
    // #809: a signed-off plan is now reachable during execution via a read-only PLAN chip on the
    // session row/tile/viewport. No targetId — the chip only appears in the executing phase and the
    // plan opens in an on-demand modal (PlanPanel), with no stable always-visible anchor (mirrors
    // the plan-question-answers entry). v1.34.0 is the latest tag → ships in 1.35.0.
    id: "plan-reopen-execution",
    sinceVersion: "1.35.0",
    titleKey: "feat_plan_reopen_title",
    bodyKey: "feat_plan_reopen_body",
  },
  {
    // targetId "lightweight-repo" matches use:coachTarget on the lightweight toggle row
    // in AutomationPanel. v1.34.0 is the latest released tag → ships in 1.35.0.
    id: "lightweight-repo-mode",
    sinceVersion: "1.35.0",
    titleKey: "feat_lightweight_repo_title",
    bodyKey: "feat_lightweight_repo_body",
    targetId: "lightweight-repo",
  },
  {
    // The filter chips (mine & unassigned, hide in progress, hide sub-issues) are now
    // grouped into a single "Filters" menu on both the Backlog and New Task issue lists.
    // The chip/targetId was removed; coachmark now lives on the IssueFilterPopover trigger.
    id: "issues-filter-mine",
    sinceVersion: "1.35.0",
    titleKey: "feat_issues_filter_mine_title",
    bodyKey: "feat_issues_filter_mine_body",
  },
  {
    // Per-repo automation settings (the in-task Automation popover) are now also a tab in
    // the Backlog drill-down, editable without launching a task. targetId "backlog-automation"
    // matches use:coachTarget on the desktop Automation tab button in BacklogView.
    // v1.34.0 is the latest released tag → ships in 1.35.0.
    id: "repo-settings-in-backlog",
    sinceVersion: "1.35.0",
    titleKey: "feat_repo_settings_backlog_title",
    bodyKey: "feat_repo_settings_backlog_body",
    targetId: "backlog-automation",
  },
  {
    // 1M-context Opus & Sonnet are now selectable in every model picker (New Task,
    // global default, per-repo automation). targetId "model-1m-context" matches
    // use:coachTarget on the New Task model field.
    // v1.34.0 is the latest released tag → ships in 1.35.0.
    id: "model-1m-context",
    sinceVersion: "1.35.0",
    titleKey: "feat_model_1m_title",
    bodyKey: "feat_model_1m_body",
    targetId: "model-1m-context",
  },
  {
    // No targetId: the toggle lives in the Settings modal SESSION tab (closed by default),
    // so a coachmark anchor would rarely be mounted — surface via the What's-New drawer only.
    // v1.34.0 is the latest released tag → ships in 1.35.0.
    id: "usage-aware-holding",
    sinceVersion: "1.35.0",
    titleKey: "feat_usage_aware_holding_title",
    bodyKey: "feat_usage_aware_holding_body",
  },
  {
    // No targetId: the ⟳ Retry button only renders in the SteerBar when usage-halted
    // sessions exist and usage has dropped back below the hold threshold, so a coachmark
    // anchor would rarely be mounted — surface via the What's-New drawer only.
    // v1.34.0 is the latest released tag → ships in 1.35.0.
    id: "usage-halt-retry",
    sinceVersion: "1.35.0",
    titleKey: "feat_usage_halt_retry_title",
    bodyKey: "feat_usage_halt_retry_body",
  },
  {
    // Effectiveness loop + safe auto-retire (#840). Surfaced in the Learnings drawer
    // (closed by default) → What's-New only, no coachmark target.
    id: "learnings-auto-retire",
    sinceVersion: "1.35.0",
    titleKey: "feat_learnings_auto_retire_title",
    bodyKey: "feat_learnings_auto_retire_body",
  },
  {
    // Ready lens now hides sessions that aren't the operator's turn (handed off to a
    // foreign reviewer/merger, or mid-merge-train). The filter tab is always mounted,
    // but the change is behavioral rather than a new control → What's-New drawer only.
    id: "ready-lens-hides-waiting",
    sinceVersion: "1.35.0",
    titleKey: "feat_ready_lens_hides_waiting_title",
    bodyKey: "feat_ready_lens_hides_waiting_body",
  },
  {
    // "Hide in progress" issue filter — drops shepherd:active issues on both the
    // Backlog and New Task issue lists. The filter now lives in the Filters menu;
    // the chip/targetId was removed. v1.34.0 is the latest released tag → 1.35.0.
    id: "issues-filter-active",
    sinceVersion: "1.35.0",
    titleKey: "feat_issues_filter_active_title",
    bodyKey: "feat_issues_filter_active_body",
  },
  {
    // targetId "backlog-ff-main" anchors the coachmark on the Fast-forward button
    // at the right end of the Backlog detail tab bar. v1.34.0 is the latest released
    // tag → ships in 1.35.0.
    id: "ff-main-standalone",
    sinceVersion: "1.35.0",
    titleKey: "feat_ff_main_title",
    bodyKey: "feat_ff_main_body",
    targetId: "backlog-ff-main",
  },
  {
    // Glob-scoped house rules (#842): a learning can carry scopeGlobs so it injects
    // only for tasks touching matching files; surfaced in the Learnings drawer (scope
    // line + editor + "Scoped" badge). v1.34.0 is the latest released tag → 1.35.0.
    id: "scoped-learnings",
    sinceVersion: "1.35.0",
    titleKey: "feat_scoped_learnings_title",
    bodyKey: "feat_scoped_learnings_body",
  },
  {
    // Background merge-suggestion pass (#843): periodically clusters a repo's near-duplicate
    // house rules and surfaces merge groups in the Learnings drawer for one-click
    // consolidation. v1.34.0 is the latest released tag → 1.35.0.
    id: "learnings-merge-suggestions",
    sinceVersion: "1.35.0",
    titleKey: "feat_learnings_merge_title",
    bodyKey: "feat_learnings_merge_body",
  },
  {
    // Cross-repo recurrence (#843): rules that recur across many repos are surfaced as a
    // suggestion to promote one to a user-global CLAUDE.md. v1.34.0 latest released → 1.35.0.
    id: "learnings-cross-repo-recurrence",
    sinceVersion: "1.35.0",
    titleKey: "feat_learnings_recur_title",
    bodyKey: "feat_learnings_recur_body",
  },
  {
    // Open linked issue (#876): GitRail shows "Issue #N ↗" link for sessions spawned
    // from a backlog issue, letting the user jump straight to the issue on GitHub/Gitea.
    id: "open-linked-issue",
    sinceVersion: "1.35.0",
    titleKey: "feat_open_linked_issue_title",
    bodyKey: "feat_open_linked_issue_body",
  },
  {
    // Auto-retire push surface (#852): a daily background pass that retires underperforming
    // rules now also fires a push notification. No targetId — the surface is an OS push, not
    // an on-screen element. v1.34.0 latest released → 1.35.0.
    id: "learnings-retire-push",
    sinceVersion: "1.35.0",
    titleKey: "feat_learnings_retire_push_title",
    bodyKey: "feat_learnings_retire_push_body",
  },
  {
    // Learnings drawer repo group headers now carry the project emoji (or the ▣
    // marker) before the repo name, matching the session-card label so it's clear
    // at a glance which repo each card concerns. Lives in the closed-by-default
    // drawer → What's-New only, no coachmark target.
    id: "learnings-repo-glyph",
    sinceVersion: "1.35.0",
    titleKey: "feat_learnings_repo_glyph_title",
    bodyKey: "feat_learnings_repo_glyph_body",
  },
  {
    // The iOS home-screen PWA now honors the system Text Size (Dynamic Type)
    // setting — the whole type scale scales from the Control Center / Settings
    // slider. No anchor element, so no coachmark. v1.34.0 is the latest released
    // tag → ships in 1.35.0.
    id: "ios-dynamic-type",
    sinceVersion: "1.35.0",
    titleKey: "feat_ios_text_size_title",
    bodyKey: "feat_ios_text_size_body",
  },
  {
    // Hide native sub-issues by default on both the Backlog and New Task issue lists,
    // nudging an epic drain from the parent. The filter now lives in the Filters menu;
    // the chip/targetId was removed. v1.34.0 is the latest released tag → 1.35.0.
    id: "hide-sub-issues-default",
    sinceVersion: "1.35.0",
    titleKey: "feat_issues_filter_subissues_title",
    bodyKey: "feat_issues_filter_subissues_body",
  },
  {
    // Issue filters grouped into a single "Filters" menu (was a row of chips) on both
    // the Backlog and New Task issue lists. targetId "issue-filters" matches
    // use:coachTarget on the IssueFilterPopover trigger (Backlog). v1.34.0 latest → 1.35.0.
    id: "issue-filters-menu",
    sinceVersion: "1.35.0",
    titleKey: "feat_issue_filters_menu_title",
    bodyKey: "feat_issue_filters_menu_body",
    targetId: "issue-filters",
  },
  {
    // One-click global promote (#872): the cross-repo recurrence card now has a guarded
    // (two-step confirm) action that writes the rule straight into the user-global
    // ~/.claude/CLAUDE.md — no PR. Lives in the closed-by-default drawer → What's-New only,
    // no coachmark target. v1.34.0 latest released → ships in 1.35.0.
    id: "learnings-promote-global",
    sinceVersion: "1.35.0",
    titleKey: "feat_learnings_promote_global_title",
    bodyKey: "feat_learnings_promote_global_body",
  },
  {
    // Reduced notifications mode (#896): a global switch (Settings → Device) that
    // silences every push except a session sitting in the "ready" filter for 5s,
    // keeping only usage/cost alerts. The control lives behind the settings gear +
    // Device tab → no always-visible anchor, so What's-New only, no coachmark.
    // v1.34.0 is the latest released tag → ships in 1.35.0.
    id: "reduced-push-mode",
    sinceVersion: "1.35.0",
    titleKey: "feat_reduced_push_title",
    bodyKey: "feat_reduced_push_body",
  },
  {
    // Auto-trial strong proposals (#925): proposals with strong, multi-source evidence are
    // auto-promoted to active "trials" (and the Wilson auto-retire net removes duds), draining
    // the manual approval queue. Trials are badged + one-click revertible in the drawer.
    id: "learnings-auto-trial",
    sinceVersion: "1.36.0",
    titleKey: "feat_learnings_auto_trial_title",
    bodyKey: "feat_learnings_auto_trial_body",
  },
  {
    // Doc-agent UI surface (#906, epic #875 P3): a per-repo Backlog trigger button +
    // run/PR status badge + brief run-history popover for the PR-gated doc agent.
    // targetId "doc-agent-trigger" matches use:coachTarget on the DocAgentControl button
    // (desktop). Opt-in (SHEPHERD_DOC_AGENT) so the anchor is absent when disabled.
    // v1.35.0 is the latest released tag → ships in 1.36.0.
    id: "doc-agent-ui",
    sinceVersion: "1.36.0",
    titleKey: "feat_doc_agent_ui_title",
    bodyKey: "feat_doc_agent_ui_body",
    targetId: "doc-agent-trigger",
  },
  {
    // Top-bar documentation link (#…): a standing docs entry next to the gear plus an
    // entry in the gear menu / mobile sheet, pointing at docs.shepherd.run. targetId
    // "docs-link" matches use:coachTarget on the standalone TopBar anchor (desktop).
    id: "docs-link",
    sinceVersion: "1.36.0",
    titleKey: "feat_docs_link_title",
    bodyKey: "feat_docs_link_body",
    targetId: "docs-link",
  },
  {
    // No targetId: the behaviour fires on a repo-chip switch in the RepoSwitcher rail
    // (only rendered when ≥2 repos have a live session), and the effect re-targets the
    // terminal rather than highlighting a control — there's no stable anchor to point a
    // coachmark at. Surface via the What's-New drawer only. v1.35.0 is the latest
    // released tag → ships in 1.36.0.
    id: "repo-switch-retarget",
    sinceVersion: "1.36.0",
    titleKey: "feat_repo_switch_retarget_title",
    bodyKey: "feat_repo_switch_retarget_body",
  },
  {
    // In-app feedback (#971): gear menu, mobile sheet, and Settings → Device each expose
    // Report a bug / Request a feature / Send feedback, opening a prefilled GitHub issue form.
    // No targetId — the menu/sheet anchors aren't persistently mounted, so it's drawer-only.
    // v1.35.0 is the latest released tag → ships in 1.36.0.
    id: "in-app-feedback",
    sinceVersion: "1.36.0",
    titleKey: "feat_feedback_title",
    bodyKey: "feat_feedback_body",
  },
  {
    id: "usage-dashboard",
    sinceVersion: "1.36.0",
    titleKey: "feat_usage_dashboard_title",
    bodyKey: "feat_usage_dashboard_body",
    targetId: "usage-link",
  },
  {
    id: "usage-limits-trend",
    sinceVersion: "1.36.0",
    titleKey: "feat_usage_limits_trend_title",
    bodyKey: "feat_usage_limits_trend_body",
  },
  {
    // Per-task `$` in the Spend lens (#980): each expanded task row now shows a dollar figure
    // (api-key auth mode only), alongside the existing per-repo + grand-total `$`. No targetId —
    // task-row `$` is only visible in api-key mode inside an expanded repo row, so there's no
    // persistently-mounted anchor to point a coachmark at; surface via the What's-New drawer only.
    // v1.35.0 is the latest released tag → ships in 1.36.0.
    id: "spend-per-task-dollars",
    sinceVersion: "1.36.0",
    titleKey: "feat_spend_per_task_dollars_title",
    bodyKey: "feat_spend_per_task_dollars_body",
  },
  {
    // Satellite-by-type breakdown in the Usage → Overhead lens. No targetId — the
    // "Satellite by type" section is hidden whenever no satellite passes ran in the selected
    // range, so a coachTarget anchor may never mount; surface via the What's-New drawer only.
    // v1.36.0 is the latest released tag → ships in 1.37.0.
    id: "usage-satellite-by-type",
    sinceVersion: "1.37.0",
    titleKey: "feat_usage_satellite_by_type_title",
    bodyKey: "feat_usage_satellite_by_type_body",
  },
  {
    // "Why parked?" hold-reason line on each held herd card + in the triage drawer (#1008).
    // No targetId: the "Why?" line mounts only when a session is actually held, so there is
    // no persistently-mounted anchor for a coachmark — surface via the What's-New drawer only
    // (same rationale as the two preceding entries). v1.36.0 is the latest released tag →
    // ships in 1.37.0.
    id: "why-parked",
    sinceVersion: "1.37.0",
    titleKey: "feat_why_parked_title",
    bodyKey: "feat_why_parked_body",
  },
  {
    // Per-task rows in the Usage → Spend + Overhead lenses now show each task's
    // human-readable short name (e.g. "add-auth-flow") with its designation as a muted
    // tag, instead of the designation alone. No targetId — the task rows mount only when a
    // repo group is expanded, so there is no persistently-mounted anchor for a coachmark;
    // surface via the What's-New drawer only. v1.36.0 is the latest released tag → ships in 1.37.0.
    id: "usage-task-names",
    sinceVersion: "1.37.0",
    titleKey: "feat_usage_task_names_title",
    bodyKey: "feat_usage_task_names_body",
  },
  {
    // Non-blocking in-terminal banner warning that an in-flight critic / plan-gate
    // review may steer the session on conclusion. Anchored on the banner itself.
    id: "review-inflight-signal",
    sinceVersion: "1.37.0",
    titleKey: "feat_review_inflight_title",
    bodyKey: "feat_review_inflight_body",
    targetId: "review-inflight",
  },
  {
    // First task for a new repo now shows an inline confirm step in the New Task dialog
    // so users can review and adjust automation settings before the first spawn. The repo
    // is seeded with plan-gate ON. Subsequent tasks on the same repo spawn silently.
    // No targetId — the confirm step is transient (shown only once per repo); no
    // persistently-mounted anchor for a coachmark. v1.36.0 → ships in 1.37.0.
    id: "first-task-confirm",
    sinceVersion: "1.37.0",
    titleKey: "feat_first_task_confirm_title",
    bodyKey: "feat_first_task_confirm_body",
  },
  {
    // Backlog issue rows now show a chip per assignee login, but only when the
    // "mine & unassigned" filter (#824) isn't hiding others' issues — so you can see who
    // already owns a piece of work. No targetId — the chips mount conditionally (filter
    // off + at least one assignee), so there's no persistently-mounted anchor for a
    // coachmark; surface via the What's-New drawer only. v1.36.0 is the latest released
    // tag → ships in 1.37.0.
    id: "issue-assignee-chip",
    sinceVersion: "1.37.0",
    titleKey: "feat_issue_assignee_title",
    bodyKey: "feat_issue_assignee_body",
  },
  {
    // Integrated-epics band now shows a "Land epic" CTA when the landing PR is ready —
    // one-click merge from the app, no GitHub context-switch needed. No targetId — the
    // band only mounts when completed epics exist; surface via the What's-New drawer only.
    // v1.36.0 → ships in 1.37.0.
    id: "land-epic-cta",
    sinceVersion: "1.37.0",
    titleKey: "feat_land_epic_title",
    bodyKey: "feat_land_epic_body",
  },
  {
    // With auto-merge enabled, an integrated epic's landing PR now lands automatically once it's
    // CLEAN + CI-green (the manual "Land epic" CTA still works). Migration-bearing epics are held
    // for manual review. No targetId — server-driven behavior with no persistent anchor; surface
    // via the What's-New drawer only. v1.36.0 → ships in 1.37.0.
    id: "epic-auto-land",
    sinceVersion: "1.37.0",
    titleKey: "feat_epic_auto_land_title",
    bodyKey: "feat_epic_auto_land_body",
  },
  {
    // The daily Herd Rundown now injects landing-ready integrated epics as a Tier-1 "land these
    // epics" section — surfacing a forgotten last-mile landing even when no session is live. No
    // targetId — the section mounts only when a landing-ready epic exists; surface via the What's-New
    // drawer only. v1.36.0 → ships in 1.37.0.
    id: "rundown-epics-to-land",
    sinceVersion: "1.37.0",
    titleKey: "feat_rundown_epics_to_land_title",
    bodyKey: "feat_rundown_epics_to_land_body",
  },
  {
    // Operators can opt agent sessions into Claude Code's fullscreen renderer (Settings → Session),
    // a research preview for flatter memory on long autonomous runs; off by default. No targetId —
    // surfaced via the What's-New drawer only. v1.36.0 is the latest released tag → ships in 1.37.0.
    id: "tui-fullscreen",
    sinceVersion: "1.37.0",
    titleKey: "feat_tui_fullscreen_title",
    bodyKey: "feat_tui_fullscreen_body",
  },
  {
    // After you manually merge a session's PR, the "Merged" toast now offers a one-click
    // Decommission action to tear down that finished session (stop the agent, remove the
    // worktree) without hunting for the decommission button. No targetId — the offer is a
    // transient toast with no persistent anchor; surface via the What's-New drawer only.
    // v1.36.0 is the latest released tag → ships in 1.37.0.
    id: "decommission-on-merge",
    sinceVersion: "1.37.0",
    titleKey: "feat_decommission_on_merge_title",
    bodyKey: "feat_decommission_on_merge_body",
  },
  {
    // The mobile terminal control bar gains a pinned ⤓ "jump to latest" key in the right-hand
    // action cluster, mirroring Claude Code's Ctrl+End scroll-to-bottom — always reachable, unlike
    // the floating ↓ that only appears when scrolled up. No targetId — the control bar mounts on
    // mobile/touch only; surface via the What's-New drawer only. v1.36.0 is the latest released tag → ships in 1.37.0.
    id: "mobile-scroll-to-end-key",
    sinceVersion: "1.37.0",
    titleKey: "feat_scroll_to_end_key_title",
    bodyKey: "feat_scroll_to_end_key_body",
  },
  {
    // Shepherd now detects manual operator steps declared in a PR's `shepherd:manual-steps` block
    // (flip a flag, set an env var, run a backfill) and surfaces them as an amber chip on the
    // session row + a checklist in the Done recap — so they aren't lost when the PR lands. No
    // targetId — the chip mounts only when steps are detected; surface via the What's-New drawer
    // only. v1.36.0 is the latest released tag → ships in 1.37.0.
    id: "manual-operator-steps",
    sinceVersion: "1.37.0",
    titleKey: "feat_manual_operator_steps_title",
    bodyKey: "feat_manual_operator_steps_body",
  },
  {
    // P2 of the manual-operator-steps epic (#1060): those declared steps now GATE auto-merge. A PR
    // with an un-acked, non-POST-MERGE step is held out of the merge train with a clear reason; an
    // "Ack steps" button on the session row clears the gate, and you're nudged via push + the daily
    // rundown. POST-MERGE-only steps never block. No targetId — the chip/CTA mount only when steps
    // are detected; surface via the What's-New drawer only. Ships in 1.37.0 alongside P1.
    id: "manual-operator-steps-gate",
    sinceVersion: "1.37.0",
    titleKey: "feat_manual_operator_steps_gate_title",
    bodyKey: "feat_manual_operator_steps_gate_body",
  },
  {
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
  },
  {
    // Epic #1071: auto-rebase for landing PRs. When paused (conflict/cap/driver), a warn chip on
    // the integrated-epics band row surfaces the reason and hands off to the operator. Ships in 1.37.0.
    id: "auto-rebase-landing-prs",
    sinceVersion: "1.37.0",
    titleKey: "feat_auto_rebase_landing_prs_title",
    bodyKey: "feat_auto_rebase_landing_prs_body",
    targetId: "rebase-paused-chip",
  },
  {
    // Issue #1079: single-operator password → session-cookie auth gating every route + both WS
    // channels (live PTY / activity stream). Logout lives in Settings → Session. Ships in 1.37.0.
    id: "operator-auth",
    sinceVersion: "1.37.0",
    titleKey: "feat_operator_auth_title",
    bodyKey: "feat_operator_auth_body",
  },
  {
    // Codex CLI support is an Alpha/MVP provider path in the task dialog plus Settings →
    // Coding CLIs. No targetId — both controls live in modal surfaces that are closed by default;
    // surface via the What's-New drawer only. Ships in 1.37.0.
    id: "codex-cli-alpha",
    sinceVersion: "1.37.0",
    titleKey: "feat_codex_cli_title",
    bodyKey: "feat_codex_cli_body",
  },
  {
    // Codex token telemetry now joins Claude usage in the topbar usage popover. No targetId —
    // the details only mount while the operator has the usage popover/sheet open; surface via
    // the What's-New drawer only. Ships in 1.37.0 alongside the Codex provider path.
    id: "codex-usage-topbar",
    sinceVersion: "1.37.0",
    titleKey: "feat_codex_usage_topbar_title",
    bodyKey: "feat_codex_usage_topbar_body",
  },
  {
    // Held tasks now show the coding CLI they were originally held for and can be manually
    // spawned on a different provider, e.g. hand a Claude-held task to Codex while Claude usage is
    // capped. No targetId — the held-task popover only mounts when the queue is non-empty. Ships
    // in 1.37.0 alongside the Codex provider path.
    id: "held-task-cli-handoff",
    sinceVersion: "1.37.0",
    titleKey: "feat_held_task_cli_handoff_title",
    bodyKey: "feat_held_task_cli_handoff_body",
  },
  {
    // Codex uses its own model family in the New Task picker; the selected alias is passed
    // through to `codex --model`. No targetId because the picker lives in a closed modal.
    id: "codex-model-picker",
    sinceVersion: "1.37.0",
    titleKey: "feat_codex_model_picker_title",
    bodyKey: "feat_codex_model_picker_body",
  },
  {
    // The task ID on every card is now a button: copy it, or have a second agent (Opus /
    // GPT-5.5) analyze the session's terminal history and recommend the next prompt to send.
    // No targetId — the trigger is per-card (many instances), so there's no single coach anchor.
    id: "task-id-prompt-recommendation",
    sinceVersion: "1.37.0",
    titleKey: "feat_taskid_recommend_title",
    bodyKey: "feat_taskid_recommend_body",
  },
  {
    // The held-task popover now has an "auto-start" checkbox. Off keeps tasks queued until the
    // operator starts each one manually instead of releasing them automatically at the next reset.
    // No targetId — the held-task popover only mounts when the queue is non-empty. Ships in 1.38.0
    // (v1.37.0 is already released; this lands after the tag).
    id: "held-task-autostart-toggle",
    sinceVersion: "1.38.0",
    titleKey: "feat_held_autostart_title",
    bodyKey: "feat_held_autostart_body",
  },
  {
    // The herdr-update dialog now lists each running session the restart would
    // interrupt, and each row jumps straight to that session — so you can wrap
    // them up one by one before updating instead of trusting a bare count. No
    // targetId — the anchor only exists while the update dialog is open.
    id: "herdr-update-session-list",
    sinceVersion: "1.38.0",
    titleKey: "feat_herdr_update_session_list_title",
    bodyKey: "feat_herdr_update_session_list_body",
  },
  {
    // No targetId: plan diagrams are per-plan (zero or many instances, only while the
    // plan panel is open), so there's no single stable coachmark anchor — surface via
    // the What's-New drawer only. 1.37.0 is the latest released tag, so this ships in 1.38.0.
    id: "plan-diagram-lightbox",
    sinceVersion: "1.38.0",
    titleKey: "feat_diagram_lightbox_title",
    bodyKey: "feat_diagram_lightbox_body",
  },
  {
    // Held tasks now carry an "Edit" button that reopens the original New Task dialog
    // pre-filled from the task's stored input, so you can fix the prompt / repo / settings
    // before it spawns. No targetId — the held-task popover only mounts when the queue is
    // non-empty. 1.37.0 is the latest released tag, so this ships in 1.38.0.
    id: "held-task-edit",
    sinceVersion: "1.38.0",
    titleKey: "feat_held_edit_title",
    bodyKey: "feat_held_edit_body",
  },
  {
    // Server-side plugin architecture (#1124): a Settings → Plugins panel surfaces
    // loaded private/out-of-repo extensions + their health. No targetId — the tab only
    // mounts when ≥1 plugin is loaded, so a coachmark would point at nothing for most.
    // 1.37.0 is the latest released tag, so this ships in 1.38.0.
    id: "server-plugins",
    sinceVersion: "1.38.0",
    titleKey: "feat_server_plugins_title",
    bodyKey: "feat_server_plugins_body",
  },
  {
    // Repos you don't care about can be hidden from the Backlog repos panel (hover a
    // row → eye-off; a "Hidden · N" chip reveals + unhides). List-only — sessions,
    // drain and totals are untouched. No targetId — the eye control + Hidden chip are
    // conditional (hover-only / only when ≥1 repo is hidden), so there's no always-present
    // anchor; surface via the What's-New drawer only. Ships in 1.38.0 (1.37.0 is latest tag).
    id: "hide-repos",
    sinceVersion: "1.38.0",
    titleKey: "feat_hide_repos_title",
    bodyKey: "feat_hide_repos_body",
  },
  {
    // Read-only scratchpad file browser (#1164): a Files tab on a live session's viewport,
    // anchored via use:coachTarget={"files-tab"} in ViewportTabBar. 1.37.0 is the latest
    // released tag, so this ships in 1.38.0.
    id: "scratchpad-files",
    sinceVersion: "1.38.0",
    titleKey: "feat_scratchpad_files_title",
    bodyKey: "feat_scratchpad_files_body",
    targetId: "files-tab",
  },
  {
    // Autopilot-until-PR is now selectable for Codex tasks (previously Claude-only). The
    // checkbox carries coachTarget "task-autopilot" in NewTaskRunSettings, so the coachmark
    // can point at it.
    id: "codex-autopilot",
    sinceVersion: "1.38.0",
    titleKey: "feat_codex_autopilot_title",
    bodyKey: "feat_codex_autopilot_body",
    targetId: "task-autopilot",
  },
  {
    // Bring back a marked-as-done session from the Done lens: re-creates the worktree on its
    // surviving branch and resumes the conversation. Recovers committed work only. 1.37.0 is the
    // latest released tag, so this ships in 1.38.0. No targetId — the button only renders when a
    // done session is selected in the Done lens, so there's no always-present anchor.
    id: "bring-back-done",
    sinceVersion: "1.38.0",
    titleKey: "feat_bring_back_title",
    bodyKey: "feat_bring_back_body",
  },
  {
    // Up Next (#1169): a top-level lens ranking un-started GitHub issues across all repos into
    // one cross-repo queue, with one-click (single + batch) Start. Anchored to the lens button
    // via use:coachTarget={"up-next-lens"} in HerdLensStrip/HerdSegRow. 1.37.0 is the latest
    // released tag, so this ships in 1.38.0.
    id: "up-next",
    sinceVersion: "1.38.0",
    titleKey: "feat_upnext_title",
    bodyKey: "feat_upnext_body",
    targetId: "up-next-lens",
  },
  {
    // "+ Add repo" in the Backlog repos panel (New project / Clone / Fork). 1.37.0 is the
    // latest released tag, so this ships in 1.38.0.
    // No targetId — DELIBERATE, despite #1171 asking for a coachmark: the only <Coachmark>
    // host (GitRail) arms exclusively from PILL_FEATURE_IDS and isn't mounted inside the
    // Backlog overlay, so an arbitrary targetId would be a permanently dead anchor (same
    // single-host limitation noted on readiness-analyzer/review-cycles above). Surface via
    // the What's-New drawer only; a real coachmark would need a new arming host (out of scope).
    id: "backlog-add-repo",
    sinceVersion: "1.38.0",
    titleKey: "feat_add_repo_title",
    bodyKey: "feat_add_repo_body",
  },
  {
    // Plugin UI descriptor (#1185): plugins can publishUI() a declarative view (meters,
    // badges, tables, key-value) rendered from a whitelisted registry in Settings → Plugins,
    // replacing the raw JSON dump. 1.37.0 is the latest released tag, so this ships in 1.38.0.
    // No targetId — the Settings → Plugins tab is conditionally mounted (hidden when no
    // plugins) and isn't a Coachmark arming host, so any targetId would be a dead anchor
    // (same single-host limitation noted on backlog-add-repo); surface via What's-New only.
    id: "plugin-ui-panels",
    sinceVersion: "1.38.0",
    titleKey: "feat_plugin_ui_title",
    bodyKey: "feat_plugin_ui_body",
  },
  {
    // Plugin UI graphical widgets (#1189): plugins can publishUI() gauges, sparklines,
    // time-series, bar-charts and timelines, rendered from the whitelisted registry in
    // Settings → Plugins, alongside the existing meter/badge/table widgets. 1.37.0 is the
    // latest released tag, so this ships in 1.38.0. No targetId — same dead-anchor limitation
    // as plugin-ui-panels (Settings → Plugins isn't a Coachmark arming host); What's-New only.
    id: "plugin-ui-charts",
    sinceVersion: "1.38.0",
    titleKey: "feat_plugin_ui_charts_title",
    bodyKey: "feat_plugin_ui_charts_body",
  },
];
