import { m } from "$lib/paraglide/messages";
import type { TooltipExplanation } from "./content";

export function planGateExplanation(): TooltipExplanation {
  return {
    title: m.gloss_plan_gate_term(),
    summary: m.gloss_plan_gate_def(),
    sections: [
      { label: m.tooltip_process(), text: m.tooltip_plan_gate_process() },
      { label: m.tooltip_release(), text: m.tooltip_plan_gate_release() },
      { label: m.tooltip_claude(), text: m.tooltip_plan_gate_claude() },
      { label: m.tooltip_codex(), text: m.tooltip_plan_gate_codex() },
    ],
  };
}

export function autopilotExplanation(): TooltipExplanation {
  return {
    title: m.gloss_autopilot_term(),
    summary: m.gloss_autopilot_def(),
    sections: [
      { label: m.tooltip_when_off(), text: m.tooltip_autopilot_off() },
      { label: m.gloss_plan_gate_term(), text: m.tooltip_autopilot_plan_gate() },
      { label: m.tooltip_codex(), text: m.tooltip_autopilot_codex() },
      { label: m.tooltip_scope(), text: m.tooltip_autopilot_scope() },
    ],
  };
}

export function coldResumeExplanation(params: {
  context: string;
  units: string;
}): TooltipExplanation {
  return {
    title: m.tooltip_cold_title(),
    summary: m.tooltip_cold_summary(params),
    sections: [
      { label: m.tooltip_cold_cost(params), text: m.tooltip_cold_cost_body(params) },
      { label: m.tooltip_cold_choice(), text: m.tooltip_cold_choice_body() },
    ],
  };
}

/** "Resolve conflicts" on a conflicting epic landing PR (#1841): what the agent does + its cost. */
export function landingConflictReworkExplanation(): TooltipExplanation {
  return {
    title: m.tooltip_landing_conflicts_title(),
    summary: m.tooltip_landing_conflicts_summary(),
    sections: [
      { label: m.tooltip_landing_conflicts_does(), text: m.tooltip_landing_conflicts_does_body() },
      {
        label: m.tooltip_landing_conflicts_consequence(),
        text: m.tooltip_landing_conflicts_consequence_body(),
      },
    ],
  };
}

/** Settings → Up Next readiness rerank (#2535): what reorders, what it costs, what happens when it can't. */
export function upNextReadinessExplanation(): TooltipExplanation {
  return {
    title: m.tooltip_up_next_readiness_title(),
    summary: m.tooltip_up_next_readiness_summary(),
    sections: [
      { label: m.tooltip_up_next_readiness_does(), text: m.tooltip_up_next_readiness_does_body() },
      { label: m.tooltip_up_next_readiness_cost(), text: m.tooltip_up_next_readiness_cost_body() },
      {
        label: m.tooltip_up_next_readiness_fallback(),
        text: m.tooltip_up_next_readiness_fallback_body(),
      },
    ],
  };
}

/** Review banner "Hold" — what holding an in-flight review does and what it costs. */
export function reviewHoldExplanation(): TooltipExplanation {
  return {
    title: m.reviewbanner_tip_hold_title(),
    summary: m.reviewbanner_tip_hold_summary(),
    sections: [
      { label: m.reviewbanner_tip_then(), text: m.reviewbanner_tip_hold_then() },
      { label: m.reviewbanner_tip_cost(), text: m.reviewbanner_tip_hold_cost() },
      { label: m.reviewbanner_tip_note(), text: m.reviewbanner_tip_hold_note() },
    ],
  };
}

/** Review banner "Resume" — releasing a held review. */
export function reviewResumeExplanation(): TooltipExplanation {
  return {
    title: m.reviewbanner_tip_resume_title(),
    summary: m.reviewbanner_tip_resume_summary(),
    sections: [{ label: m.reviewbanner_tip_then(), text: m.reviewbanner_tip_resume_then() }],
  };
}

/** Review banner "Cancel" — discarding the in-flight review. */
export function reviewCancelExplanation(): TooltipExplanation {
  return {
    title: m.reviewbanner_tip_cancel_title(),
    summary: m.reviewbanner_tip_cancel_summary(),
    sections: [
      { label: m.reviewbanner_tip_cost(), text: m.reviewbanner_tip_cancel_cost() },
      { label: m.reviewbanner_tip_then(), text: m.reviewbanner_tip_cancel_then() },
    ],
  };
}

/** Review banner "Restart" — a fresh review after a cancel. */
export function reviewRestartExplanation(): TooltipExplanation {
  return {
    title: m.reviewbanner_tip_restart_title(),
    summary: m.reviewbanner_tip_restart_summary(),
    sections: [{ label: m.reviewbanner_tip_cost(), text: m.reviewbanner_tip_restart_cost() }],
  };
}

/** Glossary + Repos-dialog slot line (#2620): what an agent slot is, who holds one, how to add more. */
export function agentSlotExplanation(): TooltipExplanation {
  return {
    title: m.tooltip_agent_slot_title(),
    summary: m.gloss_agent_slot_def(),
    sections: [
      { label: m.tooltip_agent_slot_holders(), text: m.tooltip_agent_slot_holders_body() },
      { label: m.tooltip_agent_slot_full(), text: m.tooltip_agent_slot_full_body() },
      { label: m.tooltip_agent_slot_change(), text: m.tooltip_agent_slot_change_body() },
    ],
  };
}

/** "One epic leads at a time" (#2620): a new start supersedes, the old epic winds down. */
export function epicLeadExplanation(): TooltipExplanation {
  return {
    title: m.tooltip_epic_lead_title(),
    summary: m.tooltip_epic_lead_summary(),
    sections: [
      { label: m.tooltip_epic_lead_previous(), text: m.tooltip_epic_lead_previous_body() },
      { label: m.tooltip_epic_lead_slots(), text: m.tooltip_epic_lead_slots_body() },
    ],
  };
}

/** The epic run region's live-state indicator (#2620). */
export function epicRunStateExplanation(): TooltipExplanation {
  return {
    title: m.tooltip_epic_run_state_title(),
    summary: m.tooltip_epic_run_state_summary(),
    sections: [
      { label: m.tooltip_epic_run_state_next(), text: m.tooltip_epic_run_state_next_body() },
      { label: m.tooltip_epic_run_state_you(), text: m.tooltip_epic_run_state_you_body() },
    ],
  };
}

/** Terminal auto-merge strip — what full auto-merge does and when it needs the operator. */
export function autoMergeStripExplanation(): TooltipExplanation {
  return {
    title: m.automergebanner_tip_title(),
    summary: m.automergebanner_tip_summary(),
    sections: [
      { label: m.automergebanner_tip_you(), text: m.automergebanner_tip_you_body() },
      { label: m.automergebanner_tip_waits(), text: m.automergebanner_tip_waits_body() },
      { label: m.automergebanner_tip_needs_you(), text: m.automergebanner_tip_needs_you_body() },
    ],
  };
}

/** Issues panel rate-limit notice — whether GitHub's API limit can be raised, and what to
 *  do meanwhile. `resumeTime` is the reload time the notice shows, or null when unknown. */
export function githubRateLimitRaiseExplanation(resumeTime: string | null): TooltipExplanation {
  return {
    title: m.issues_ratelimit_raise_title(),
    summary: m.issues_ratelimit_raise_summary(),
    sections: [
      { label: m.issues_ratelimit_raise_no_label(), text: m.issues_ratelimit_raise_no() },
      { label: m.issues_ratelimit_raise_yes_label(), text: m.issues_ratelimit_raise_yes() },
      { label: m.issues_ratelimit_raise_cost_label(), text: m.issues_ratelimit_raise_cost() },
      {
        label: m.issues_ratelimit_raise_now_label(),
        text:
          resumeTime === null
            ? m.issues_ratelimit_raise_now_unknown()
            : m.issues_ratelimit_raise_now({ time: resumeTime }),
      },
    ],
  };
}

/** What remains between completed sub-tasks and an epic landing in main. */
export function epicsToLandExplanation(): TooltipExplanation {
  return {
    title: m.integrated_epics_help_title(),
    summary: m.integrated_epics_help_summary(),
    sections: [
      { label: m.integrated_epics_help_landing_label(), text: m.integrated_epics_help_landing() },
      { label: m.integrated_epics_help_you_label(), text: m.integrated_epics_help_you() },
      { label: m.integrated_epics_dismiss(), text: m.integrated_epics_help_remove() },
      { label: m.integrated_epics_help_excluded_label(), text: m.integrated_epics_help_excluded() },
    ],
  };
}

export function landingPrExplanation(): TooltipExplanation {
  return {
    title: m.gloss_landing_pr_term(),
    summary: m.gloss_landing_pr_def(),
    sections: [
      { label: m.tooltip_process(), text: m.integrated_epics_help_landing() },
      { label: m.integrated_epics_help_you_label(), text: m.integrated_epics_help_you() },
    ],
  };
}

export function integrationBranchExplanation(): TooltipExplanation {
  return {
    title: m.gloss_integration_branch_term(),
    summary: m.gloss_integration_branch_def(),
    sections: [
      { label: m.integrated_epics_help_landing_label(), text: m.integrated_epics_help_landing() },
      { label: m.integrated_epics_help_excluded_label(), text: m.integrated_epics_help_excluded() },
    ],
  };
}

/** Automation → "Shared browser": what the per-repo logged-in Chromium is for, who can read its
 *  logins, and what it needs. */
export function sharedBrowserExplanation(): TooltipExplanation {
  return {
    title: m.tooltip_shared_browser_title(),
    summary: m.tooltip_shared_browser_summary(),
    sections: [
      { label: m.tooltip_shared_browser_for(), text: m.tooltip_shared_browser_for_body() },
      { label: m.tooltip_shared_browser_cost(), text: m.tooltip_shared_browser_cost_body() },
      { label: m.tooltip_shared_browser_needs(), text: m.tooltip_shared_browser_needs_body() },
    ],
  };
}
