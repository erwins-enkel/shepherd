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
