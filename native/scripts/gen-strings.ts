#!/usr/bin/env bun
/**
 * Mirrors a fixed subset of the web message catalogs into the macOS app's
 * String Catalog.
 *
 *   bun native/scripts/gen-strings.ts            # writes Localizable.xcstrings
 *   bun native/scripts/gen-strings.ts --check    # fails if the file is stale
 *
 * Paraglide uses {name} placeholders; .xcstrings uses positional %1$@. Names are
 * numbered by first appearance in the EN string and the SAME numbering is applied
 * to DE, so a translator may reorder placeholders freely.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const EN = join(ROOT, "ui", "messages", "en.json");
const DE = join(ROOT, "ui", "messages", "de.json");
const OUT = join(ROOT, "native", "Apps", "ShepherdMac", "Resources", "Localizable.xcstrings");

/**
 * Every catalog key the macOS app is allowed to use, split by the parallel
 * stream that owns it. A stream edits ONLY its own array, so two branches
 * appending keys produce insertion conflicts a rebase resolves rather than a
 * fight over one list. Keep each array alphabetical.
 *
 * Core: the shell — window, welcome, login, first run, session list, detail
 * header, shared status and effort labels.
 */
export const KEYS_CORE: readonly string[] = [
  "agent_provider_claude",
  "agent_provider_codex",
  "common_cancel",
  "common_close",
  "common_loading",
  "common_retry",
  "common_save",
  "effort_default",
  "effort_label_high",
  "effort_label_low",
  "effort_label_max",
  "effort_label_medium",
  "effort_label_ultra",
  "effort_label_xhigh",
  "login_busy",
  "login_error",
  "login_password_label",
  "login_password_placeholder",
  "login_submit",
  "login_subtitle",
  "native_archive_confirm_action",
  "native_archive_confirm_body",
  "native_archive_confirm_title",
  "native_archive_failed",
  "native_banner_client_too_old",
  "native_banner_mismatch",
  "native_banner_needs_login",
  "native_banner_offline",
  "native_banner_unhealthy",
  "native_detail_no_selection",
  "native_detail_placeholder_body",
  "native_detail_placeholder_title",
  "native_detail_status_label",
  "native_error_first_run",
  "native_error_forbidden",
  "native_error_keychain",
  "native_error_mismatch",
  "native_error_not_found",
  "native_error_offline",
  "native_firstrun_body",
  "native_firstrun_choose",
  "native_firstrun_confirm",
  "native_firstrun_failed",
  "native_firstrun_title",
  "native_interrupt_failed",
  "native_login_sheet_title",
  "native_menu_session",
  "native_newsession_held",
  "native_newsession_provider_label",
  "native_settings_placeholder_body",
  "native_settings_placeholder_title",
  "native_sidebar_empty",
  "native_sidebar_title",
  "native_signout_failed",
  "native_toolbar_add_server",
  "native_toolbar_archive",
  "native_toolbar_interrupt",
  "native_toolbar_new_session",
  "native_toolbar_servers",
  "native_toolbar_sign_out",
  "native_url_error_empty",
  "native_url_error_insecure",
  "native_url_error_malformed",
  "native_welcome_connect",
  "native_welcome_local_body",
  "native_welcome_local_detecting",
  "native_welcome_local_found",
  "native_welcome_local_missing",
  "native_welcome_local_recheck",
  "native_welcome_local_title",
  "native_welcome_remote_body",
  "native_welcome_remote_name_label",
  "native_welcome_remote_name_placeholder",
  "native_welcome_remote_title",
  "native_welcome_remote_url_label",
  "native_welcome_remote_url_placeholder",
  "native_welcome_saved_connect",
  "native_welcome_saved_remove",
  "native_welcome_saved_remove_confirm_action",
  "native_welcome_saved_remove_confirm_body",
  "native_welcome_saved_remove_confirm_title",
  "native_welcome_saved_title",
  "native_welcome_subtitle",
  "native_welcome_title",
  "newtask_branch_label",
  "newtask_branch_placeholder",
  "newtask_create_failed",
  "newtask_effort_label",
  "newtask_model_default",
  "newtask_model_label",
  "newtask_prompt_label",
  "newtask_prompt_placeholder",
  "newtask_repo_label",
  "newtask_spawning",
  "newtask_submit",
  "newtask_title",
  "status_archived",
  "status_blocked",
  "status_done",
  "status_idle",
  "status_working",
];

/** Terminal stream (S1). Keep alphabetical. */
export const KEYS_TERMINAL: readonly string[] = [
  "native_terminal_connecting",
  "native_terminal_ended_body",
  "native_terminal_ended_title",
  "native_terminal_prompt_failed",
  "native_terminal_prompt_placeholder",
  "native_terminal_prompt_send",
  "native_terminal_superseded_action",
  "native_terminal_superseded_body",
  "native_terminal_superseded_title",
  "native_terminal_tab_title",
  "native_terminal_unreachable_body",
  "native_terminal_unreachable_title",
];

/**
 * S2 — detail tabs: activity, diff, files, PR status and PR actions. Only this
 * stream edits this array. Keep alphabetical. Everything without the
 * `native_detail_` prefix is an existing web key reused verbatim, which is what
 * the i18n rule prefers.
 */
export const KEYS_DETAIL: readonly string[] = [
  "activity_empty",
  "diff_empty",
  "diff_note_binary",
  "diff_note_no_changes",
  "diff_note_truncated",
  "diff_refresh",
  "diff_stale",
  "files_created_unknown",
  "files_empty",
  "files_link_outside_title",
  "files_load_error",
  "files_source_scratchpad",
  "files_source_worktree",
  "files_worktree_empty",
  "files_worktree_load_error",
  "gitrail_ci_failing",
  "gitrail_ci_none",
  "gitrail_ci_passing",
  "gitrail_ci_pending",
  "gitrail_create_pr",
  "gitrail_merge",
  "gitrail_status_failed",
  "native_detail_action_failed",
  "native_detail_annotation_agent",
  "native_detail_close_confirm_action",
  "native_detail_close_confirm_body",
  "native_detail_close_confirm_title",
  "native_detail_git_none",
  "native_detail_merge_confirm_action",
  "native_detail_merge_confirm_body",
  "native_detail_merge_confirm_title",
  "native_detail_refresh",
  "native_detail_reviewer_label",
  "native_detail_tab_activity",
  "native_detail_tab_diff",
  "native_detail_tab_files",
  "native_detail_tab_git",
  "prbadge_mark_draft",
  "prbadge_mark_ready",
  "prreview_load_failed",
  "prreview_loading",
  "prreview_no_candidates",
  "prreview_title",
  "viewport_diff_annotation_review",
];

/** Keys the Herd sidebar and header strip use. Owned by stream S3 — keep alphabetical. */
export const KEYS_SIDEBAR: readonly string[] = [
  "herd_all_title",
  "herd_awaiting_merge_group",
  "herd_changes_requested_group",
  "herd_ci_failed_group",
  "herd_ci_running_group",
  // `herd_done_empty` is the web's Done-PANEL line. The Done lens is panel-only in the web
  // and ships disabled here (`HerdLens.isAvailable`), so nothing in this build can render it.
  "herd_done_title",
  "herd_draft_awaiting_signoff_group",
  "herd_lenses_label",
  "herd_merge_blocked_group",
  "herd_merged_group",
  "herd_merging_group",
  "herd_next_title",
  "herd_owed_title",
  "herd_ready_empty",
  "herd_ready_group",
  "herd_ready_title",
  "herd_repo_filter_empty",
  "herd_reviewer_running_group",
  "herd_rework_running_group",
  "herd_seg_all",
  "herd_seg_done",
  "herd_seg_next",
  "herd_seg_owed",
  "herd_seg_ready",
  "herd_stage_name_active",
  "herd_waiting_merger_group",
  "herd_waiting_merger_group_multi",
  "herd_waiting_reviewer_group",
  "herd_waiting_reviewer_group_multi",
  "native_herd_counter_active",
  "native_herd_counter_blocked",
  "native_herd_counter_idle",
  "native_herd_counter_total",
  "repo_filter_active_aria",
  "repo_filter_apply_aria",
  "repo_switcher_label",
  "research_badge_label",
  "session_autopilot_paused_label",
  "terminal_badge_label",
  "unitrow_manual_steps",
  "unitrow_quota_error",
  "unitrow_quota_review",
  "unitrow_quota_rework",
  "usage_limits_no_data",
  "usage_limits_window_5h",
  "usage_limits_window_week",
  "usage_subscription_only",
];

/** S4 — the quick-action bar and the "Handlungsbedarf" recap line. Keep alphabetical. */
export const KEYS_ACTIONS: readonly string[] = [
  "amend_failed",
  "amend_original_task",
  "amend_placeholder",
  "amend_recorded",
  "amend_recorded_and_steered",
  "amend_recorded_not_steered",
  "amend_sending",
  "amend_steer_label",
  "amend_steer_offline",
  "amend_submit",
  "amend_title",
  "cardmenu_amend",
  "cardmenu_relaunch",
  "cardmenu_rename",
  "cardmenu_resume",
  "cardmenu_resume_failed",
  "cardmenu_stop",
  "cardmenu_stop_failed",
  "cardmenu_stop_title",
  "cardmenu_stop_toast",
  "gitrail_ready",
  "gitrail_ready_aria",
  "gitrail_ready_off_title",
  "gitrail_ready_on_title",
  "native_actions_bar_label",
  "native_actions_failed",
  "native_actions_open_items",
  "native_actions_ready_off",
  "native_actions_ready_on",
  "native_actions_recap_requested",
  "native_actions_relaunch_confirm_action",
  "native_actions_relaunch_confirm_body",
  "native_actions_relaunch_confirm_title",
  "native_actions_resumed",
  "recap_open_items",
  "recap_regenerate",
  "recap_regenerate_failed",
  "recap_verdict_needs_attention",
  "recap_verdict_parked",
  "recap_verdict_ready",
  "relaunch_archive_failed",
  "relaunch_done",
  "relaunch_in_progress",
  "relaunch_issue_unresolved",
  "toast_renamed",
  "viewport_rename_aria",
  "viewport_rename_branch_kept",
  "viewport_rename_failed",
  "viewport_rename_name_taken",
  "viewport_rename_placeholder",
];

/** S5 — local server detection, install, start/stop/restart and the log tail. */
export const KEYS_LOCALSERVER: readonly string[] = [
  "native_local_connect",
  "native_local_error_bun_missing",
  "native_local_error_crash_loop",
  "native_local_error_exited",
  "native_local_error_health_timeout",
  "native_local_error_install_failed",
  "native_local_error_not_checkout",
  "native_local_install",
  "native_local_log_hide",
  "native_local_log_show",
  "native_local_password_body",
  "native_local_password_copy",
  "native_local_password_title",
  "native_local_restart",
  "native_local_start",
  "native_local_state_external",
  "native_local_state_installing",
  "native_local_state_not_installed",
  "native_local_state_running",
  "native_local_state_starting",
  "native_local_state_stopped",
  "native_local_stop",
];

/** S6 — notification titles and bodies. Keep alphabetical. */
export const KEYS_NOTIFICATIONS: readonly string[] = [
  "hold_blocked_awaiting_input",
  "hold_blocked_generic",
  "hold_blocked_menu",
  "hold_blocked_stall",
  "hold_blocked_yes_no",
  "hold_quota_error",
  "hold_quota_plan",
  "hold_quota_review",
  "hold_quota_rework",
  "native_notify_blocked_title",
  "native_notify_done_body",
  "native_notify_done_title",
  "native_notify_manual_steps_body",
  "native_notify_manual_steps_title",
  "native_notify_merge_error_body",
  "native_notify_merge_error_title",
  "native_notify_ready_body",
  "native_notify_ready_title",
  "native_notify_rebase_cap_body",
  "native_notify_rebase_cap_title",
  "native_notify_settings_enabled",
  "native_notify_settings_menu_item",
  "native_notify_settings_permission_ask",
  "native_notify_settings_permission_denied",
  "native_notify_settings_quiet_hint",
  "native_notify_settings_scope",
  "native_notify_settings_title",
  "native_notify_usage_body",
  "native_notify_usage_body_reset",
  "native_notify_usage_title",
  "settings_push_cat_agent",
  "settings_push_cat_ci",
];

/** S7 — the herd classifier: lifecycle group headings the sidebar already has live in
 *  KEYS_SIDEBAR; this array is for the stepper, the row badges and the CI/review banners. */
export const KEYS_HERD: readonly string[] = [
  "herd_waiting_reviewer_group_maintainers",
  "herd_waiting_merger_group_maintainers",
  "activity_active",
  "activity_ci_failure",
  "activity_ci_pending",
  "activity_ci_status",
  "activity_ci_success",
  "activity_closed",
  "activity_merged",
  "activity_progress",
  "activity_review_approved",
  "activity_review_changes",
  "activity_review_reviewing",
  "activity_review_status",
  "activity_stage_implementing",
  "activity_stage_planning",
  "activity_stage_pr",
  "activity_stage_ready",
  "activity_stage_review",
  "activity_starting",
  "clibadge_label_claude",
  "clibadge_label_codex",
  "clibadge_title",
  "criticbadge_changes",
  "criticbadge_commented",
  "criticbadge_error",
  "criticbadge_final",
  "criticbadge_final_title",
  "criticbadge_open_pr",
  "criticbadge_reviewing",
  "criticbadge_reviewing_activity_title",
  "criticbadge_reviewing_title",
  "criticbadge_round",
  "criticbadge_round_title",
  "criticbadge_stalled",
  "criticbadge_stalled_title",
  "criticbadge_title",
  "gitrail_ci_status",
  "gitrail_merge_blocked_behind",
  "gitrail_merge_blocked_checks",
  "gitrail_merge_blocked_conflict",
  "gitrail_merge_blocked_draft",
  "gitrail_merge_blocked_protected",
  "heartbeat_legend_active_desc",
  "heartbeat_legend_active_label",
  "heartbeat_legend_error_desc",
  "heartbeat_legend_error_label",
  "heartbeat_legend_idle_desc",
  "heartbeat_legend_idle_label",
  "heartbeat_pop_intro",
  "issuebadge_label",
  "issuebadge_open_label",
  "issuebadge_title",
  "prbadge_behind",
  "prbadge_behind_title",
  "prbadge_button_title",
  "prbadge_closed",
  "prbadge_conflict",
  "prbadge_conflict_title",
  "prbadge_draft",
  "prbadge_merged",
  "prbadge_open",
  "prbadge_review_approved",
  "prbadge_review_changes",
  "prbadge_review_comment",
  "session_autopilot_complete_label",
  "session_autopilot_complete_title",
  "session_autopilot_paused_title",
  "session_autopilot_unavailable_label",
  "session_autopilot_unavailable_title",
  "status_merging",
  "status_merging_tip",
  "status_ready_tip",
  "status_ready_to_merge",
  "stepper_desc_implementing",
  "stepper_desc_planning",
  "stepper_desc_pr",
  "stepper_desc_ready",
  "stepper_desc_review",
  "stepper_legend_done",
  "stepper_legend_now",
  "stepper_legend_pending",
  "stepper_legend_skipped",
  "stepper_open_hint",
  "unitrow_changes_requested",
  "unitrow_changes_requested_title",
  "unitrow_merge_blocked",
  "unitrow_merge_blocked_title",
  "unitrow_unknown_reviewer",
];

/** S8 — plan gates: the badge chips, the plan panel, the visual-block renderer and the
 *  question form. */
export const KEYS_PLAN: readonly string[] = [
  "hold_cta_answer",
  "hold_cta_answer_title",
  "plangate_changes",
  "plangate_edited",
  "plangate_error",
  "plangate_menu_editor_label",
  "plangate_menu_editor_reset",
  "plangate_menu_editor_send",
  "plangate_menu_label",
  "plangate_menu_open_plan",
  "plangate_menu_rereview",
  "plangate_menu_send_changes",
  "plangate_menu_why",
  "plangate_menu_why_body",
  "plangate_planning",
  "plangate_ready",
  "plangate_repair_no_findings",
  "plangate_repair_send_failed",
  "plangate_repair_sent",
  "plangate_repair_steer",
  "plangate_review_at_cap",
  "plangate_review_skipped_stalled",
  "plangate_review_spends_round",
  "plangate_review_started",
  "plangate_reviewing",
  "plangate_tip_changes",
  "plangate_tip_changes_stalled",
  "plangate_tip_edited",
  "plangate_tip_error",
  "plangate_tip_planning",
  "plangate_tip_ready",
  "plangate_tip_reviewing",
  "plangate_tip_reviewing_env",
  "plangate_tip_view",
  "plangate_title",
  "plangate_view",
  "planpanel_back_aria",
  "planpanel_edited_note",
  "planpanel_empty",
  "planpanel_env_aria",
  "planpanel_env_docs_link",
  "planpanel_env_help_aria",
  "planpanel_env_plan",
  "planpanel_env_popover_body",
  "planpanel_env_popover_title",
  "planpanel_env_review",
  "planpanel_env_unavailable",
  "planpanel_findings",
  "planpanel_go",
  "planpanel_membrane_launch",
  "planpanel_native_go_confirm",
  "planpanel_native_go_failed",
  "planpanel_native_not_releasable",
  "planpanel_no_verdict",
  "planpanel_plan_unavailable",
  "planpanel_proposed_caption",
  "planpanel_quota_dismiss",
  "planpanel_quota_dismissing",
  "planpanel_quota_failed",
  "planpanel_quota_not_stalled",
  "planpanel_quota_resume",
  "planpanel_quota_resuming",
  "planpanel_quota_unreachable",
  "planpanel_review_already_approved",
  "planpanel_review_at_cap",
  "planpanel_review_at_cap_no_resume",
  "planpanel_review_failed",
  "planpanel_review_failed_auth",
  "planpanel_review_failed_spawn",
  "planpanel_review_failed_worktree",
  "planpanel_review_nothing_to_review",
  "planpanel_review_now",
  "planpanel_review_plan_unavailable",
  "planpanel_reviewing",
  "planpanel_reviewing_env",
  "planpanel_status_changes",
  "planpanel_status_changes_stalled",
  "planpanel_status_edited",
  "planpanel_status_error",
  "planpanel_status_planning",
  "planpanel_status_ready",
  "planpanel_status_reviewing",
  "planpanel_status_view",
  "planpanel_title",
  "planpanel_verdict",
  "qform_freeform_placeholder",
  "qform_kind_freeform",
  "qform_kind_multi",
  "qform_kind_multi_optional",
  "qform_kind_single",
  "qform_native_confirm_body",
  "qform_sent",
  "qform_sent_undelivered",
  "qform_submit",
  "qform_submit_error",
  "qform_submitting",
  "vblock_apiendpoint_deprecated",
  "vblock_apiendpoint_params",
  "vblock_apiendpoint_required",
  "vblock_apiendpoint_responses",
  "vblock_callout_decision",
  "vblock_callout_info",
  "vblock_callout_risk",
  "vblock_callout_success",
  "vblock_callout_warning",
  "vblock_code_truncated",
  "vblock_datamodel_fk",
  "vblock_datamodel_nullable",
  "vblock_datamodel_pk",
  "vblock_datamodel_relations",
  "vblock_datamodel_was",
  "vblock_diff_highlighted_heading",
  "vblock_filetree_added",
  "vblock_filetree_modified",
  "vblock_filetree_removed",
  "vblock_filetree_renamed",
  "vblock_inferred",
  "vblock_mermaid_error",
  "vblock_mermaid_expand",
  "vblock_native_not_rendered",
  "vblock_native_wireframe_omitted",
  "vblock_wireframe_mockup_label",
  "vblock_wireframe_surface_browser",
  "vblock_wireframe_surface_desktop",
  "vblock_wireframe_surface_mobile",
  "vblock_wireframe_surface_panel",
  "vblock_wireframe_surface_popover",
];

/** S9 — merge, automation and post-merge steps. */
export const KEYS_MERGE: readonly string[] = [];

/** S10 — held tasks, up-next, done/recaps, halt and retry. */
export const KEYS_QUEUES: readonly string[] = [
  "broadcast_clear_all",
  "broadcast_confirm_send",
  "broadcast_failed",
  "broadcast_no_sessions",
  "broadcast_placeholder",
  "broadcast_select_all",
  "broadcast_send_to",
  "broadcast_sending",
  "broadcast_steer",
  "broadcast_targets",
  "broadcast_textarea_aria",
  "broadcast_title",
  "common_issues_load_failed",
  "done_recap_finished",
  "done_recap_panel_aria",
  "donerecap_bringback",
  "donerecap_bringback_confirm",
  "halt_all_aria",
  "halt_arm",
  "halt_arm_aria",
  "halt_confirm",
  "halt_done",
  "halt_failed",
  "halt_menu_item",
  "herd_done_empty",
  "newtask_edit_held_failed",
  "newtask_edit_held_saving",
  "newtask_edit_held_submit",
  "newtask_edit_held_title",
  "owed_empty",
  "owed_repo_filter_empty",
  "owed_title",
  "recap_changed_files",
  "recap_empty_legacy",
  "recap_failed",
  "recap_failure_auth_action",
  "recap_failure_auth_headline",
  "recap_failure_default_model",
  "recap_failure_detail",
  "recap_failure_details",
  "recap_failure_invalid_result_headline",
  "recap_failure_launch_headline",
  "recap_failure_model",
  "recap_failure_no_result_headline",
  "recap_failure_provider",
  "recap_failure_provider_action",
  "recap_failure_source_action",
  "recap_failure_source_headline",
  "recap_failure_timeout_headline",
  "recap_generating",
  "recap_predates_feature",
  "recap_unavailable",
  "restore_branch_gone",
  "restore_branch_in_use",
  "restore_cannot",
  "restore_done",
  "restore_failed",
  "restore_in_progress",
  "restore_not_archived",
  "retry_arm",
  "retry_confirm",
  "retry_continue_steer",
  "retry_empty",
  "retry_failed",
  "retry_halted_badge",
  "retry_title",
  "toast_auto_revived",
  "toast_broadcast_delivered",
  "toast_broadcast_result",
  "toast_broadcast_skipped_terminals",
  "toast_held_edit_saved",
  "toast_retry_done",
  "toast_revive_all",
  "toast_revive_all_failed",
  "toast_revive_all_result",
  "toast_sessions_stranded",
  "topbar_held_badge",
  "topbar_held_discard",
  "topbar_held_discard_confirm",
  "topbar_held_discard_failed",
  "topbar_held_discarding",
  "topbar_held_edit",
  "topbar_held_empty",
  "topbar_held_original_cli",
  "topbar_held_reason_usage",
  "topbar_held_reason_capacity",
  "topbar_held_reason_unknown",
  "topbar_held_spawn_cli_label",
  "topbar_held_spawn_failed",
  "topbar_held_spawn_now",
  "topbar_held_spawning",
  "topbar_held_title",
  "upnext_batch_aria",
  "upnext_clear_selection",
  "upnext_confirm",
  "upnext_confirm_yes",
  "upnext_empty",
  "upnext_held",
  "upnext_normal_section",
  "upnext_picker_confirm",
  "upnext_picker_title",
  "upnext_pill_epic",
  "upnext_pill_priority",
  "upnext_priority_section",
  "upnext_refresh",
  "upnext_repo_filter_empty",
  "upnext_select_aria",
  "upnext_show_all",
  "upnext_show_less",
  "upnext_sort_aria",
  "upnext_sort_by",
  "upnext_sort_newest",
  "upnext_sort_oldest",
  "upnext_sort_recommended",
  "upnext_sort_title_asc",
  "upnext_sort_title_desc",
  "upnext_start",
  "upnext_start_failed",
  "upnext_start_selected",
  "upnext_started",
  "upnext_title",
  "upnext_updated_ago",
  "usage_prompt_tokens_unit",
];

/** S11 — the composer: create fields, slash commands, steers, attachments. */
export const KEYS_COMPOSE: readonly string[] = [
  "newtask_agent_provider_label",
  "newtask_agent_provider_codex_alpha_badge",
  "newtask_provider_capacity_title",
  "newtask_provider_capacity_meter_window_aria",
  "newtask_provider_capacity_free",
  "newtask_provider_capacity_free_until",
  "newtask_provider_capacity_unavailable",
  "newtask_capacity_all",
  "newtask_capacity_all_aria",
  "newtask_attach_image",
  "newtask_remove_image_aria",
  "newtask_uploading",
  "newtask_upload_failed",
  "newtask_upload_percent",
  "newtask_upload_unknown_reason",
  "newtask_agent_provider_codex_alpha_note",
  "newtask_agent_provider_codex_note",
  "newtask_agent_provider_codex_suggested_for_hold",
  "newtask_alpha_caution",
  "newtask_alpha_details",
  "newtask_autopilot_hint",
  "newtask_group_guards",
  "newtask_guard_autopilot",
  "newtask_guard_plan_gate",
  "newtask_plan_gate_hint",
  "newtask_research_sandbox_note",
  "newtask_sandbox_default",
  "newtask_sandbox_hint",
  "newtask_sandbox_label",
  "newtask_toggle_off",
  "newtask_toggle_on",
  "sandbox_profile_autonomous",
  "sandbox_profile_standard",
  "sandbox_profile_trusted",
  "newtask_group_mode",
  "newtask_guards_none_epic",
  "newtask_guards_none_plain",
  "newtask_guards_none_research",
  "newtask_mode_code",
  "newtask_mode_epic",
  "newtask_mode_plain",
  "newtask_mode_research",
  "newtask_base_missing",
  "newtask_chip_from",
  "newtask_init_commit",
  "newtask_init_commit_failed",
  "newtask_init_commit_running",
  "newtask_readiness_base_missing",
  "newtask_upstream_checking",
  "newtask_upstream_behind",
  "newtask_upstream_diverged",
  "common_issues_lightweight",
  "common_no_open_issues",
  "issue_filter_button",
  "issue_filter_button_aria",
  "issue_filter_heading",
  "issues_filter_active_label",
  "issues_filter_active_title",
  "issues_filter_all_assigned_to_others",
  "issues_filter_all_blocked",
  "issues_filter_all_in_progress",
  "issues_filter_all_sub_issues",
  "issues_filter_author_all",
  "issues_filter_author_heading",
  "issues_filter_blocked_label",
  "issues_filter_blocked_title",
  "issues_filter_labels_heading",
  "issues_filter_mine_label",
  "issues_filter_mine_title",
  "issues_filter_no_match",
  "issues_filter_subissues_label",
  "issues_filter_subissues_title",
  "newtask_issue_prompt_template",
  "newtask_issue_remove_aria",
  "newtask_provider_constraint_body",
  "newtask_provider_constraint_title",
  "promptsources_collapse_row",
  "promptsources_commands_filter",
  "promptsources_commands_tab",
  "promptsources_issues_tab",
  "promptsources_more_row",
  "promptsources_no_commands",
  "promptsources_no_github",
  "promptsources_open_count",
  "promptsources_title",
];

/** S12 — the settings panes, the command menu and the usage gauges. */
export const KEYS_SETTINGS: readonly string[] = [];

/**
 * The manifest the catalog is generated from. Order here does not reach the
 * output — `build()` sorts before emitting — but is fixed so the concatenation
 * is easy to assert.
 */
export const KEYS: readonly string[] = [
  ...KEYS_CORE,
  ...KEYS_TERMINAL,
  ...KEYS_DETAIL,
  ...KEYS_SIDEBAR,
  ...KEYS_ACTIONS,
  ...KEYS_LOCALSERVER,
  ...KEYS_NOTIFICATIONS,
  ...KEYS_HERD,
  ...KEYS_PLAN,
  ...KEYS_MERGE,
  ...KEYS_QUEUES,
  ...KEYS_COMPOSE,
  ...KEYS_SETTINGS,
];

/**
 * Keys appearing more than once, sorted. Two streams claiming the same key is an
 * authoring mistake the sorted, de-duplicating emit would otherwise hide: the
 * catalog would be right and `KEYS.length` would be a lie.
 */
export function duplicateKeys(keys: readonly string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) dupes.add(key);
    else seen.add(key);
  }
  return [...dupes].sort();
}

type Catalog = Record<string, string>;

function load(path: string): Catalog {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const out: Catalog = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === "string") out[k] = v;
  return out;
}

/**
 * {name} -> %N$@, numbered by first appearance in `order`.
 *
 * `%` is only escaped to `%%` when the string carries at least one placeholder
 * (`order.size > 0`): those strings go through `String(format:)` at runtime
 * (`L.t(key, args...)`), where a bare `%` would be misread as a conversion.
 * A string with no placeholders is read via `L.t(key)`, which returns
 * `String(localized:)` verbatim with no format pass — escaping `%` there
 * would print a literal `%%` in the UI.
 */
export function convert(value: string, order: Map<string, number>): string {
  const escaped = order.size === 0 ? value : value.replace(/%/g, "%%");
  return escaped.replace(/\{(\w+)\}/g, (_m, name: string) => {
    const index = order.get(name);
    if (index === undefined) throw new Error(`unknown placeholder {${name}}`);
    return `%${index}$@`;
  });
}

export function placeholderOrder(en: string): Map<string, number> {
  const order = new Map<string, number>();
  for (const m of en.matchAll(/\{(\w+)\}/g)) {
    const name = m[1]!;
    if (!order.has(name)) order.set(name, order.size + 1);
  }
  return order;
}

function build(): string {
  const en = load(EN);
  const de = load(DE);

  const dupes = duplicateKeys(KEYS);
  if (dupes.length > 0) {
    throw new Error(`keys claimed by more than one stream manifest: ${dupes.join(", ")}`);
  }

  const missing: string[] = [];
  for (const key of KEYS) {
    if (en[key] === undefined) missing.push(`en.json: ${key}`);
    if (de[key] === undefined) missing.push(`de.json: ${key}`);
  }
  if (missing.length > 0) {
    throw new Error(`missing catalog keys:\n  ${missing.join("\n  ")}`);
  }

  const strings: Record<string, unknown> = {};
  for (const key of [...KEYS].sort()) {
    const order = placeholderOrder(en[key]!);
    const comment =
      order.size === 0 ? undefined : [...order].map(([name, i]) => `%${i}$@ = ${name}`).join(", ");
    strings[key] = {
      ...(comment ? { comment } : {}),
      extractionState: "manual",
      localizations: {
        de: { stringUnit: { state: "translated", value: convert(de[key]!, order) } },
        en: { stringUnit: { state: "translated", value: convert(en[key]!, order) } },
      },
    };
  }

  return `${JSON.stringify({ sourceLanguage: "en", strings, version: "1.0" }, null, 2)}\n`;
}

// Guarded so the test suite can import `convert`/`placeholderOrder`/`KEYS`
// above without this CLI running the (real) --check/write logic as a side
// effect of the import.
if (import.meta.main) {
  const check = process.argv.includes("--check");
  const next = build();

  if (check) {
    let current = "";
    try {
      current = readFileSync(OUT, "utf8");
    } catch {
      /* a missing file is a mismatch */
    }
    if (current !== next) {
      console.error(
        "Localizable.xcstrings is stale. Run native/scripts/gen-strings.sh and commit the result.",
      );
      process.exit(1);
    }
    console.log(`Localizable.xcstrings is up to date (${KEYS.length} keys).`);
  } else {
    writeFileSync(OUT, next, "utf8");
    console.log(`Wrote ${OUT} (${KEYS.length} keys, en + de).`);
  }
}
