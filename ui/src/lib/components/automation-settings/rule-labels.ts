import { m } from "#lib/paraglide/messages.js";
import type { RuleField } from "#lib/repo-config-fields.js";

/** Each shared rule's display name. A Record, so a new RuleField without a label fails to type-check. */
const RULE_NAMES: Record<RuleField, () => string> = {
  leitrechner: m.automation_layers_leader,
  criticEnabled: m.automation_critic_name,
  criticAllPrs: m.automation_allprs_name,
  criticSmellLensEnabled: m.automation_smelllens_name,
  claudeReviewSkipsCritic: m.automation_claudereview_name,
  autoAddressEnabled: m.automation_autoaddress_name,
  autopilotEnabled: m.automation_autopilot_name,
  planGateEnabled: m.automation_plan_gate_name,
  autoDrainEnabled: m.automation_autodrain_name,
  autoMergeEnabled: m.automation_automerge_name,
  buildQueueEnabled: m.automation_buildqueue_name,
  draftMode: m.reposettings_merge_mode_draft,
  signoffAuthority: m.automation_signoff_authority_label,
  manualStepsIssueEnabled: m.automation_manual_steps_issue_name,
  preWarmEpicLandingCi: m.automation_prewarm_epic_ci_name,
  epicStacksEnabled: m.automation_epic_stacks_name,
  labelDrainAlongsideEpics: m.automation_alongside_epics_name,
  claudeShipStewardDefer: m.automation_claude_ship_steward_defer_name,
  autoLabel: m.drain_label_label,
  defaultModel: m.automation_default_model_label,
  defaultEffort: m.automation_default_effort_label,
  reviewFeedbackMode: m.reposettings_review_feedback_name,
  reviewFeedbackBots: m.reposettings_review_bots_name,
  reviewFeedbackResolve: m.reposettings_review_resolve_name,
};

export function ruleName(key: RuleField): string {
  return RULE_NAMES[key]();
}
