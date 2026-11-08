import { m } from "#lib/paraglide/messages.js";
import type { AutomationFlags } from "../git-rail-automation";
import type { AgentProvider, RepoConfig, SandboxProfile } from "#lib/types.js";
import { autonomyLevelOf, type AutonomyLevel } from "#lib/autonomy.js";
import { effectiveMergeMode, type MergeMode } from "#lib/merge-mode.js";

// The repo settings' sections (#3443), in the order work flows, and each one's short status for
// the window's navigation. Pure: the window reads the store into a SectionSnapshot.

export const REPO_SETTINGS_SECTIONS = [
  "autonomy",
  "agent",
  "start",
  "schedules",
  "review",
  "merge",
  "epics",
  "display",
] as const;
export type RepoSettingsSection = (typeof REPO_SETTINGS_SECTIONS)[number];

export function sectionLabel(id: RepoSettingsSection): string {
  switch (id) {
    case "autonomy":
      return m.reposettings_section_autonomy();
    case "agent":
      return m.reposettings_section_agent();
    case "start":
      return m.reposettings_section_start();
    case "schedules":
      return m.reposettings_section_schedules();
    case "review":
      return m.reposettings_section_review();
    case "merge":
      return m.reposettings_section_merge();
    case "epics":
      return m.reposettings_section_epics();
    case "display":
      return m.reposettings_section_display();
  }
}

/** What the navigation's short status lines read. */
export interface SectionSnapshot {
  /** The CLI new tasks start on. */
  cli: AgentProvider;
  /** The sandbox this repo's spawns run under; null while an inherited default is unknown. */
  sandbox: SandboxProfile | null;
  lightweight: boolean;
  flags: AutomationFlags;
  /** This repo's schedules; null until they loaded. */
  schedules: number | null;
  epicStacks: boolean;
  preWarmEpicLandingCi: boolean;
  pinned: boolean;
  hidden: boolean;
  previewOpenMode: RepoConfig["previewOpenMode"];
}

/** An autonomy level's name (#3445); "custom" when the config matches none. */
export function autonomyLevelName(level: AutonomyLevel | "custom"): string {
  switch (level) {
    case "onCall":
      return m.reposettings_autonomy_oncall();
    case "review":
      return m.reposettings_autonomy_review();
    case "backlog":
      return m.reposettings_autonomy_backlog();
    case "full":
      return m.reposettings_autonomy_full();
    case "custom":
      return m.reposettings_autonomy_custom();
  }
}

/** How finished PRs land, as the Merge section's choice names it. */
export function mergeModeName(mode: MergeMode): string {
  if (mode === "draft") return m.reposettings_merge_mode_draft();
  return mode === "auto" ? m.automation_automerge_name() : m.reposettings_merge_mode_manual();
}

export function cliName(cli: AgentProvider): string {
  return cli === "codex" ? m.agent_provider_codex() : m.agent_provider_claude();
}

/** The context menus' short status under "Repo settings …" (#3445): level · CLI · merge mode, in
 *  the words the window uses — its Autonomy status, its CLI and its Merge choice. */
export function repoShortStatus(s: Pick<SectionSnapshot, "cli" | "lightweight" | "flags">): string {
  const merge = effectiveMergeMode(
    { draftMode: s.flags.draftMode, autoMergeEnabled: s.flags.autoMerge },
    s.lightweight,
  );
  return [
    autonomyLevelName(autonomyLevelOf(s.flags, s.lightweight)),
    cliName(s.cli),
    mergeModeName(merge),
  ].join(" · ");
}

const onOf = (states: boolean[]) =>
  m.reposettings_summary_on({ on: states.filter(Boolean).length, total: states.length });

function sandboxName(p: SandboxProfile | null): string {
  if (p === "trusted") return m.sandbox_profile_trusted();
  if (p === "standard") return m.sandbox_profile_standard();
  if (p === "autonomous") return m.sandbox_profile_autonomous();
  return m.automation_sandbox_inherit_unresolved();
}

function previewName(mode: RepoConfig["previewOpenMode"]): string {
  if (mode === "inline") return m.preview_open_mode_inline();
  if (mode === "tab") return m.preview_open_mode_tab();
  return m.preview_open_mode_ask();
}

function schedulesSummary(n: number | null): string {
  if (n == null) return "";
  if (n === 0) return m.reposettings_summary_schedules_none();
  return n === 1
    ? m.reposettings_summary_schedules_one()
    : m.reposettings_summary_schedules({ count: n });
}

function mergeSummary(s: SectionSnapshot): string {
  if (s.lightweight) return m.reposettings_mode_local();
  if (s.flags.draftMode) return m.reposettings_summary_merge_draft();
  return s.flags.autoMerge
    ? m.reposettings_summary_merge_auto()
    : m.reposettings_summary_merge_manual();
}

function displaySummary(s: SectionSnapshot): string {
  if (s.pinned) return m.backlog_pinned_label();
  return s.hidden ? m.reposettings_summary_hidden() : previewName(s.previewOpenMode);
}

/** One short status line per section. Counts follow the rows' own gating: a switch that has no
 *  effect (Auto-address without the Critic, a GitHub-only switch in a local repo) counts as off. */
export function sectionSummary(id: RepoSettingsSection, s: SectionSnapshot): string {
  const f = s.flags;
  const forge = !s.lightweight;
  switch (id) {
    case "autonomy":
      return autonomyLevelName(autonomyLevelOf(f, s.lightweight));
    case "agent":
      return `${cliName(s.cli)} · ${sandboxName(s.sandbox)}`;
    case "start":
      return onOf([f.autoDrain && forge, f.planGate, f.buildQueue, f.autopilot]);
    case "schedules":
      return schedulesSummary(s.schedules);
    case "review":
      return onOf([
        f.critic,
        f.autoAddress && f.critic,
        f.smellLens && f.critic,
        f.criticAllPrs && forge,
      ]);
    case "merge":
      return mergeSummary(s);
    case "epics":
      return onOf([s.epicStacks && forge, s.preWarmEpicLandingCi && forge]);
    case "display":
      return displaySummary(s);
  }
}
