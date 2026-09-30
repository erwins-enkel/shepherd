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
