import { m } from "#lib/paraglide/messages.js";
import type { RuleField } from "#lib/repo-config-fields.js";
export function ruleName(key: RuleField): string {
  switch (key) {
    case "leitrechner":
      return m.automation_layers_leader();
    case "criticEnabled":
      return m.automation_critic_name();
    case "criticAllPrs":
      return m.automation_allprs_name();
    case "criticSmellLensEnabled":
      return m.automation_smelllens_name();
    case "autoAddressEnabled":
      return m.automation_autoaddress_name();
    case "autopilotEnabled":
      return m.automation_autopilot_name();
    case "planGateEnabled":
      return m.automation_plan_gate_name();
    case "autoDrainEnabled":
      return m.automation_autodrain_name();
    case "autoMergeEnabled":
      return m.automation_automerge_name();
    case "buildQueueEnabled":
      return m.automation_buildqueue_name();
    case "draftMode":
      return m.reposettings_merge_mode_draft();
    case "signoffAuthority":
      return m.automation_signoff_authority_label();
    case "manualStepsIssueEnabled":
      return m.automation_manual_steps_issue_name();
    case "preWarmEpicLandingCi":
      return m.automation_prewarm_epic_ci_name();
    case "epicStacksEnabled":
      return m.automation_epic_stacks_name();
    case "autoLabel":
      return m.drain_label_label();
    case "defaultModel":
      return m.automation_default_model_label();
    case "defaultEffort":
      return m.automation_default_effort_label();
  }
}
