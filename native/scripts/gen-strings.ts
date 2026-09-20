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
  "native_newsession_held",
  "native_newsession_provider_label",
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

/** S4 — the quick-action bar and the "Handlungsbedarf" recap line. */
export const KEYS_ACTIONS: readonly string[] = [];

/** S5 — local server detection, install, start/stop/restart and the log tail. */
export const KEYS_LOCALSERVER: readonly string[] = [];

/** S6 — notification titles and bodies. */
export const KEYS_NOTIFICATIONS: readonly string[] = [];

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
