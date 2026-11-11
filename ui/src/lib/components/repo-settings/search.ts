import { m } from "#lib/paraglide/messages.js";
import { sectionLabel, type RepoSettingsSection } from "./sections";

export interface RepoSettingsSearchEntry {
  /** null identifies the repo mode in the shared header. */
  section: RepoSettingsSection | null;
  field: string;
  fallbackField?: string;
  name: string;
  description: string;
}

/** Use the same messages as the rows, evaluated in the current locale, even for unmounted sections. */
export function repoSettingsSearchEntries(): RepoSettingsSearchEntry[] {
  return [
    { section: null, field: "repoMode", name: m.reposettings_mode_label(), description: "" },
    {
      section: "autonomy",
      field: "autonomyLevel",
      name: m.reposettings_autonomy_name(),
      description: m.reposettings_autonomy_desc(),
    },
    {
      section: "autonomy",
      field: "autonomyChain",
      name: m.reposettings_chain_name(),
      description: m.reposettings_chain_desc(),
    },
    {
      section: "agent",
      field: "agentProvider",
      name: m.automation_coding_cli_label(),
      description: "",
    },
    {
      section: "agent",
      field: "defaultModel",
      name: m.automation_default_model_label(),
      description: m.automation_default_model_hint(),
    },
    {
      section: "agent",
      field: "defaultEffort",
      name: m.automation_default_effort_label(),
      description: m.automation_default_effort_hint(),
    },
    {
      section: "agent",
      field: "defaultExecutionEffort",
      name: m.automation_execution_effort_label(),
      description: m.automation_execution_effort_hint(),
    },
    {
      section: "agent",
      field: "sandboxProfile",
      name: m.automation_sandbox_profile_label(),
      description: m.automation_sandbox_profile_summary(),
    },
    {
      section: "agent",
      field: "egressExtraHosts",
      name: m.automation_egress_hosts_label(),
      description: "",
      fallbackField: "sandboxProfile",
    },
    {
      section: "agent",
      field: "sharedBrowserEnabled",
      name: m.automation_shared_browser_name(),
      description: m.automation_shared_browser_desc(),
    },
    {
      section: "agent",
      field: "browserAllowedHosts",
      name: m.automation_browser_hosts_label(),
      description: "",
      fallbackField: "sharedBrowserEnabled",
    },
    {
      section: "agent",
      field: "claudeAiConnectorsEnabled",
      name: m.automation_claudeai_connectors_name(),
      description: m.automation_claudeai_connectors_desc(),
    },
    {
      section: "agent",
      field: "pluginAllowlist",
      name: m.automation_agent_ext_name(),
      description: m.automation_agent_ext_desc(),
    },
    {
      section: "start",
      field: "autoDrainEnabled",
      name: m.automation_autodrain_name(),
      description: m.automation_autodrain_desc(),
    },
    {
      section: "start",
      field: "maxAuto",
      name: m.drain_cap_label(),
      description: m.drain_cap_hint(),
      fallbackField: "autoDrainEnabled",
    },
    {
      section: "start",
      field: "autoLabel",
      name: m.drain_label_label(),
      description: m.drain_label_hint(),
      fallbackField: "autoDrainEnabled",
    },
    {
      section: "start",
      field: "priorityLabels",
      name: m.automation_priority_labels_label(),
      description: "",
      fallbackField: "autoDrainEnabled",
    },
    {
      section: "start",
      field: "usageCeilingPct",
      name: m.drain_ceiling_label(),
      description: m.drain_ceiling_hint(),
      fallbackField: "autoDrainEnabled",
    },
    {
      section: "start",
      field: "bootstrap",
      name: m.automation_bootstrap_name(),
      description: m.automation_bootstrap_desc(),
      fallbackField: "autoDrainEnabled",
    },
    {
      section: "start",
      field: "planGateEnabled",
      name: m.automation_plan_gate_name(),
      description: m.automation_plan_gate_desc(),
    },
    {
      section: "start",
      field: "buildQueueEnabled",
      name: m.automation_buildqueue_name(),
      description: m.automation_buildqueue_desc(),
    },
    {
      section: "start",
      field: "autopilotEnabled",
      name: m.automation_autopilot_name(),
      description: m.automation_autopilot_desc(),
    },
    { section: "schedules", field: "schedules", name: m.schedules_title(), description: "" },
    {
      section: "review",
      field: "criticEnabled",
      name: m.automation_critic_name(),
      description: m.automation_critic_desc(),
    },
    {
      section: "review",
      field: "autoAddressEnabled",
      name: m.automation_autoaddress_name(),
      description: m.automation_autoaddress_desc(),
    },
    {
      section: "review",
      field: "criticSmellLensEnabled",
      name: m.automation_smelllens_name(),
      description: m.automation_smelllens_desc(),
    },
    {
      section: "review",
      field: "criticAllPrs",
      name: m.automation_allprs_name(),
      description: m.automation_allprs_desc(),
    },
    {
      section: "merge",
      field: "draftMode",
      name: m.reposettings_merge_mode_name(),
      description: "",
    },
    {
      section: "merge",
      field: "signoffAuthority",
      name: m.automation_signoff_authority_label(),
      description: "",
      fallbackField: "draftMode",
    },
    {
      section: "merge",
      field: "mergeWithoutCi",
      name: m.automation_merge_without_ci_name(),
      description: m.automation_merge_without_ci_desc(),
    },
    {
      section: "merge",
      field: "manualStepsIssueEnabled",
      name: m.automation_manual_steps_issue_name(),
      description: m.automation_manual_steps_issue_desc(),
    },
    {
      section: "merge",
      field: "roles.reviewer",
      name: m.roles_reviewer_label(),
      description: m.automation_roles_hint(),
    },
    {
      section: "merge",
      field: "roles.merger",
      name: m.roles_merger_label(),
      description: m.automation_roles_hint(),
    },
    {
      section: "epics",
      field: "epicStacksEnabled",
      name: m.automation_epic_stacks_name(),
      description: m.automation_epic_stacks_desc(),
    },
    {
      section: "epics",
      field: "preWarmEpicLandingCi",
      name: m.automation_prewarm_epic_ci_name(),
      description: m.automation_prewarm_epic_ci_desc(),
    },
    {
      section: "display",
      field: "previewOpenMode",
      name: m.automation_preview_open_mode_label(),
      description: m.automation_preview_open_mode_hint(),
    },
    {
      section: "display",
      field: "pinned",
      name: m.reposettings_pin_name(),
      description: m.reposettings_pin_desc(),
    },
    {
      section: "display",
      field: "hidden",
      name: m.reposettings_hide_name(),
      description: m.reposettings_hide_desc(),
    },
  ];
}

export function searchRepoSettings(query: string): RepoSettingsSearchEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return repoSettingsSearchEntries().filter((entry) =>
    [entry.name, entry.description, entry.section ? sectionLabel(entry.section) : ""].some((text) =>
      text.toLowerCase().includes(q),
    ),
  );
}
