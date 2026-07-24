import { m } from "$lib/paraglide/messages";

export const SETTINGS_SECTION_IDS = [
  "workspace",
  "codingAgents",
  "steers",
  "plugins",
  "session",
  "device",
  "diagnose",
] as const;
export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

/** Rail/list glyphs are plain unicode (no icon library) per the design handoff. */
export const SECTION_GLYPHS: Record<SettingsSectionId, string> = {
  workspace: "▦",
  codingAgents: "⌁",
  steers: "⇥",
  plugins: "✦",
  session: "⌖",
  device: "◫",
  diagnose: "⚠",
};

/** One nav entry as SettingsShell renders it — metadata only, never content. */
export interface SettingsSectionNav {
  id: SettingsSectionId;
  glyph: string;
  label: string;
  /** Current-value summary shown on the mobile section list ("" = none). */
  summary: string;
  /** Rows matching the active search query (rail badge + header count). */
  matchCount: number;
  /** Active diagnostics issues (red rail dot / mobile ISSUE chip). */
  alertCount: number;
}

/** How many rows match the query — a row is one `[title, description?]` entry. */
export function matchCount(rows: string[][], query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  return rows.filter((row) => row.some((t) => t.toLowerCase().includes(q))).length;
}

export const ROLE_BASES = [
  "planner",
  "critic",
  "docAgent",
  "recap",
  "rundown",
  "distiller",
  "optimizer",
  "mergeSuggest",
  "namer",
  "autopilot",
] as const;
export type RoleBase = (typeof ROLE_BASES)[number];

export function roleTitle(role: RoleBase): string {
  switch (role) {
    case "planner":
      return m.settings_role_model_planner_title();
    case "critic":
      return m.settings_role_model_critic_title();
    case "docAgent":
      return m.settings_role_model_docagent_title();
    case "recap":
      return m.settings_role_model_recap_title();
    case "rundown":
      return m.settings_role_model_rundown_title();
    case "namer":
      return m.settings_role_model_namer_title();
    case "autopilot":
      return m.settings_role_model_autopilot_title();
    case "distiller":
      return m.settings_role_model_distiller_title();
    case "optimizer":
      return m.settings_role_model_optimizer_title();
    case "mergeSuggest":
      return m.settings_role_model_merge_suggest_title();
  }
}

export function roleHint(role: RoleBase): string {
  switch (role) {
    case "planner":
      return m.settings_role_model_planner_hint();
    case "critic":
      return m.settings_role_model_critic_hint();
    case "docAgent":
      return m.settings_role_model_docagent_hint();
    case "recap":
      return m.settings_role_model_recap_hint();
    case "rundown":
      return m.settings_role_model_rundown_hint();
    case "namer":
      return m.settings_role_model_namer_hint();
    case "autopilot":
      return m.settings_role_model_autopilot_hint();
    case "distiller":
      return m.settings_role_model_distiller_hint();
    case "optimizer":
      return m.settings_role_model_optimizer_hint();
    case "mergeSuggest":
      return m.settings_role_model_merge_suggest_hint();
  }
}

/** The Coding CLI section's rows by group. The panel derives its group counts
 *  ("N settings") and search auto-expand from this, and the shell's rail badge
 *  counts flatten it — one source, so copy edits can't drift the counts away
 *  from what actually highlights. Parameterized on the active default provider
 *  because only that provider's model row is rendered. */
export function codingCliRows(provider: "claude" | "codex"): {
  defaults: string[][];
  claude: string[][];
  codex: string[][];
  roles: string[][];
} {
  return {
    defaults: [
      [m.settings_default_agent_provider_title(), m.settings_default_cli_desc()],
      provider === "claude"
        ? [m.settings_default_model_title(), m.settings_default_model_hint()]
        : [m.settings_default_codex_model_title(), m.settings_default_codex_model_hint()],
      [m.settings_upnext_skip_cli_picker_label(), m.settings_upnext_skip_cli_picker_hint()],
    ],
    claude: [
      [m.settings_default_effort_title(), m.settings_default_effort_hint()],
      [m.settings_operator_language_title(), m.settings_operator_language_hint()],
      [m.settings_auth_mode_title(), m.settings_auth_mode_hint()],
    ],
    codex: [[m.settings_cli_codex_auth_title(), m.settings_cli_codex_auth_hint()]],
    roles: ROLE_BASES.map((r) => [roleTitle(r), roleHint(r)]),
  };
}

/** Live values for the Session section's parameterized descriptions, so the
 *  index matches the exact text the pane renders. The defaults mirror the
 *  server seeds and only apply before the settings payload lands. */
export interface SessionRowsCtx {
  retentionDays?: number;
  retentionKeep?: number;
  prReviewCyclesMin?: number;
  prReviewCyclesMax?: number;
  planReviewCyclesMin?: number;
  planReviewCyclesMax?: number;
}

/** The Session section's rows — titles + descriptions, with parameterized
 *  hints rendered from the live values the pane itself shows. */
function sessionRows(ctx: SessionRowsCtx): string[][] {
  return [
    [m.settings_remote_control_title(), m.settings_remote_control_hint()],
    [
      m.settings_housekeeping_title(),
      m.settings_housekeeping_hint({
        days: ctx.retentionDays ?? 30,
        count: ctx.retentionKeep ?? 250,
      }),
    ],
    [m.settings_auto_revive_title(), m.settings_auto_revive_hint()],
    [m.settings_telemetry_title(), m.settings_telemetry_hint()],
    [
      m.settings_pr_review_cycles_title(),
      m.settings_pr_review_cycles_hint({
        min: ctx.prReviewCyclesMin ?? 1,
        max: ctx.prReviewCyclesMax ?? 8,
      }),
    ],
    [
      m.settings_plan_review_cycles_title(),
      m.settings_plan_review_cycles_hint({
        min: ctx.planReviewCyclesMin ?? 1,
        max: ctx.planReviewCyclesMax ?? 12,
      }),
    ],
    [m.restart_title(), m.restart_settings_hint()],
    [m.settings_logout_title(), m.settings_logout_hint()],
    [m.settings_extra_credits_ceiling_title(), m.settings_extra_credits_ceiling_hint()],
    [m.settings_usage_hold_enabled_label(), m.settings_usage_hold_hint()],
    [m.settings_usage_hold_pct_label(), m.settings_usage_hold_pct_hint()],
    [m.settings_usage_downgrade_enabled_label(), m.settings_usage_downgrade_hint()],
    [m.settings_usage_downgrade_pct_label(), m.settings_usage_downgrade_pct_hint()],
    [m.settings_usage_downgrade_model_label(), m.settings_usage_downgrade_model_hint()],
    [m.settings_fable_available_label(), m.settings_fable_available_hint()],
    [m.settings_tui_fullscreen_label(), m.settings_tui_fullscreen_hint()],
    [m.settings_tui_disable_mouse_label(), m.settings_tui_disable_mouse_hint()],
  ];
}

/** Searchable rows per section. Rebuilt sections (Coding CLI, Session) list
 *  every row; sections whose panels keep bespoke internals (workspace,
 *  plugins, device, diagnostics) contribute their primary labels only — a
 *  documented boundary of the label-level search there. */
export function sectionSearchRows(ctx: {
  provider: "claude" | "codex";
  session?: SessionRowsCtx;
}): Record<SettingsSectionId, string[][]> {
  const cli = codingCliRows(ctx.provider);
  return {
    workspace: [
      [m.settings_tab_workspace()],
      [m.settings_current_root_label()],
      [m.settings_use_folder()],
    ],
    codingAgents: [
      [m.settings_tab_coding_agents()],
      ...cli.defaults,
      ...cli.claude,
      ...cli.codex,
      ...cli.roles,
    ],
    steers: [[m.settings_tab_steers()], [m.steerseditor_title(), m.steerseditor_hint()]],
    plugins: [[m.settings_tab_plugins()], [m.plugins_check_updates()]],
    session: [[m.settings_tab_session()], ...sessionRows(ctx.session ?? {})],
    device: [
      [m.settings_tab_device()],
      [m.actionbar_theme_group_aria()],
      [m.settings_contrast_title(), m.settings_contrast_hint()],
      [m.settings_colorblind_title(), m.settings_colorblind_hint()],
      [m.settings_tab_ticker_title(), m.settings_tab_ticker_hint()],
      [m.settings_hide_info_tips_title(), m.settings_hide_info_tips_hint()],
      [m.settings_push_title()],
      [m.settings_reduced_push_title(), m.settings_reduced_push_hint()],
      [m.settings_feedback_title(), m.settings_feedback_blurb()],
      [m.settings_extension_title(), m.settings_extension_blurb()],
      [m.settings_about_title(), m.settings_about_blurb()],
    ],
    diagnose: [[m.settings_tab_diagnose()], [m.diagnostics_title(), m.diagnostics_subtitle()]],
  };
}
