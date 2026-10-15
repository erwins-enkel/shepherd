import { m } from "#lib/paraglide/messages.js";
import type { TooltipExplanation } from "./content";
import {
  ASSISTANT_ACTION_GROUPS,
  type AssistantActionGroup,
  type AssistantPermissions,
  type Placement,
  type PlacementWait,
  type RemoteDispatch,
  type SessionConnection,
  type SessionHost,
} from "#lib/types.js";
import { statusLabel } from "#lib/format.js";
import {
  assistantActionLevelLabel,
  assistantGroupHint,
  assistantGroupTitle,
  assistantShellLevelLabel,
} from "#lib/assistant-permissions.js";
import { basename } from "#lib/components/learnings-drawer.js";
import { lastKnownLabel, platformName, type MirroredSession } from "#lib/remote-sessions.js";
import { capabilityList, placementReason } from "#lib/placement.js";
import { isBlocked, missingList, offlineLabel } from "#lib/remote-dispatches.js";

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

/** Epic landing card "Fix CI failures" (#2872): what the repair agent does, what it costs, what follows. */
export function landingCiRepairExplanation(): TooltipExplanation {
  return {
    title: m.tooltip_landing_ci_title(),
    summary: m.tooltip_landing_ci_summary(),
    sections: [
      { label: m.tooltip_landing_ci_does(), text: m.tooltip_landing_ci_does_body() },
      { label: m.tooltip_landing_ci_cost(), text: m.tooltip_landing_ci_cost_body() },
      { label: m.tooltip_landing_ci_after(), text: m.tooltip_landing_ci_after_body() },
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

/** Settings → Workspace "House Stack" (#3108) — what the list feeds and why a failure pins nothing. */
export function houseStackExplanation(): TooltipExplanation {
  return {
    title: m.tooltip_house_stack_title(),
    summary: m.tooltip_house_stack_summary(),
    sections: [
      { label: m.tooltip_house_stack_does(), text: m.tooltip_house_stack_does_body() },
      { label: m.tooltip_house_stack_pins(), text: m.tooltip_house_stack_pins_body() },
      { label: m.tooltip_house_stack_failure(), text: m.tooltip_house_stack_failure_body() },
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

/** "One epic leads at a time" (#2620): another epic queues behind the leader (#2624) or a start
 *  supersedes it, and the old epic winds down. */
export function epicLeadExplanation(): TooltipExplanation {
  return {
    title: m.tooltip_epic_lead_title(),
    summary: m.tooltip_epic_lead_summary(),
    sections: [
      { label: m.tooltip_epic_lead_queue(), text: m.tooltip_epic_lead_queue_body() },
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

/** Browser allowed hosts (#2898): what to enter, what is always refused, what else it needs. */
export function browserAllowedHostsExplanation(): TooltipExplanation {
  return {
    title: m.tooltip_browser_hosts_title(),
    summary: m.tooltip_browser_hosts_summary(),
    sections: [
      { label: m.tooltip_browser_hosts_allowed(), text: m.tooltip_browser_hosts_allowed_body() },
      { label: m.tooltip_browser_hosts_refused(), text: m.tooltip_browser_hosts_refused_body() },
      { label: m.tooltip_browser_hosts_needs(), text: m.tooltip_browser_hosts_needs_body() },
    ],
  };
}

/** Browser View "Pop out" (#2896): where it opens and what happens to the other view. */
export function browserPopoutExplanation(): TooltipExplanation {
  return {
    title: m.viewport_browser_popout_tip_title(),
    summary: m.viewport_browser_popout_tip_summary(),
    sections: [
      {
        label: m.viewport_browser_popout_tip_one(),
        text: m.viewport_browser_popout_tip_one_body(),
      },
      {
        label: m.viewport_browser_popout_tip_close(),
        text: m.viewport_browser_popout_tip_close_body(),
      },
    ],
  };
}

/** New Task "Research" mode button: what it produces and which guards it switches off. */
export function researchModeExplanation(): TooltipExplanation {
  return {
    title: m.tooltip_mode_research_title(),
    summary: m.tooltip_mode_research_summary(),
    sections: [
      { label: m.tooltip_mode_research_output(), text: m.tooltip_mode_research_output_body() },
      { label: m.tooltip_mode_research_guards(), text: m.tooltip_mode_research_guards_body() },
    ],
  };
}

/** New Task "Epic" mode button: what the draft holds and when GitHub is touched. */
export function epicModeExplanation(): TooltipExplanation {
  return {
    title: m.tooltip_mode_epic_title(),
    summary: m.tooltip_mode_epic_summary(),
    sections: [
      { label: m.tooltip_mode_epic_draft(), text: m.tooltip_mode_epic_draft_body() },
      { label: m.tooltip_mode_epic_github(), text: m.tooltip_mode_epic_github_body() },
    ],
  };
}

/** New Task "Plain" mode button: what stays and what Shepherd leaves out. */
export function plainModeExplanation(): TooltipExplanation {
  return {
    title: m.tooltip_mode_plain_title(),
    summary: m.tooltip_mode_plain_summary(),
    sections: [
      { label: m.tooltip_mode_plain_kept(), text: m.tooltip_mode_plain_kept_body() },
      { label: m.tooltip_mode_plain_dropped(), text: m.tooltip_mode_plain_dropped_body() },
    ],
  };
}

/** New Task "Bootstrap" mode button (#3109): what one bootstrap session delivers and what it needs. */
export function bootstrapModeExplanation(): TooltipExplanation {
  return {
    title: m.tooltip_mode_bootstrap_title(),
    summary: m.tooltip_mode_bootstrap_summary(),
    sections: [
      { label: m.tooltip_mode_bootstrap_output(), text: m.tooltip_mode_bootstrap_output_body() },
      { label: m.tooltip_mode_bootstrap_pins(), text: m.tooltip_mode_bootstrap_pins_body() },
      { label: m.tooltip_mode_bootstrap_guards(), text: m.tooltip_mode_bootstrap_guards_body() },
      { label: m.tooltip_mode_bootstrap_phases(), text: m.tooltip_mode_bootstrap_phases_body() },
    ],
  };
}

/** New Task per-task sandbox select: what each profile confines. */
export function sandboxOverrideExplanation(): TooltipExplanation {
  return {
    title: m.tooltip_sandbox_title(),
    summary: m.tooltip_sandbox_summary(),
    sections: [
      { label: m.tooltip_sandbox_default(), text: m.tooltip_sandbox_default_body() },
      { label: m.tooltip_sandbox_standard(), text: m.tooltip_sandbox_standard_body() },
      { label: m.tooltip_sandbox_autonomous(), text: m.tooltip_sandbox_autonomous_body() },
      { label: m.tooltip_sandbox_tokens(), text: m.tooltip_sandbox_tokens_body() },
    ],
  };
}

/** Operator Assistant (#1446): the Assist toggle and the panel's mode chip. With `permissions`,
 *  "What it may do" lists each Settings → Assistant row with its level; `settingsLink` adds the
 *  footer saying a click opens that section (the chip). */
export function operatorAssistantExplanation(
  permissions: AssistantPermissions | null = null,
  settingsLink = false,
): TooltipExplanation {
  return {
    title: m.operator_assistant_title(),
    summary: m.operator_assistant_tip_summary(),
    sections: [
      { label: m.operator_assistant_tip_reads(), text: m.operator_assistant_tip_reads_body() },
      {
        label: m.operator_assistant_tip_may(),
        text: m.operator_assistant_tip_may_body(),
        rows: permissions
          ? [
              {
                text: m.settings_assistant_shell_title(),
                aside: assistantShellLevelLabel(permissions.shell),
              },
              ...ASSISTANT_ACTION_GROUPS.map((g) => ({
                text: assistantGroupTitle(g),
                aside: assistantActionLevelLabel(permissions[g]),
              })),
            ]
          : undefined,
      },
      { label: m.operator_assistant_tip_herdr(), text: m.operator_assistant_tip_herdr_body() },
    ],
    footer: settingsLink ? [m.operator_assistant_tip_open_settings()] : undefined,
  };
}

/** Settings → Assistant, the shell row: what each level lets run. */
export function assistantShellExplanation(): TooltipExplanation {
  return {
    title: m.settings_assistant_shell_title(),
    summary: m.settings_assistant_shell_tip_summary(),
    sections: [
      {
        label: m.settings_assistant_tip_levels(),
        text: "",
        rows: [
          { text: m.settings_assistant_shell_tip_off() },
          { text: m.settings_assistant_shell_tip_ask() },
          { text: m.settings_assistant_shell_tip_read() },
          { text: m.settings_assistant_shell_tip_all() },
        ],
      },
      { label: m.settings_assistant_tip_locked(), text: m.settings_assistant_tip_locked_body() },
    ],
  };
}

/** Settings → Assistant, one action group's row: the levels, and what Allowed costs. */
export function assistantGroupExplanation(group: AssistantActionGroup): TooltipExplanation {
  return {
    title: assistantGroupTitle(group),
    summary: assistantGroupHint(group),
    sections: [
      {
        label: m.settings_assistant_tip_levels(),
        text: "",
        rows: [
          { text: m.settings_assistant_tip_off() },
          { text: m.settings_assistant_tip_ask() },
          { text: m.settings_assistant_tip_allow() },
        ],
      },
      { label: m.settings_assistant_tip_risk(), text: m.settings_assistant_tip_risk_body() },
    ],
  };
}

/** New Task "Run on" (#2763): how Automatic chooses the machine (#2772), where the session starts,
 *  what the machine has of the code, and what happens when it cannot start there. */
export function runOnExplanation(): TooltipExplanation {
  return {
    title: m.tooltip_runon_title(),
    summary: m.tooltip_runon_summary(),
    sections: [
      { label: m.tooltip_runon_auto(), text: m.tooltip_runon_auto_body() },
      { label: m.tooltip_runon_code(), text: m.tooltip_runon_code_body() },
      { label: m.tooltip_runon_attachments(), text: m.tooltip_runon_attachments_body() },
      { label: m.tooltip_runon_failure(), text: m.tooltip_runon_failure_body() },
    ],
  };
}

/** Requirements read from the task's description (#2773): what was read, and that the chips are
 *  the operator's to correct. */
export function derivedRequirementsExplanation(): TooltipExplanation {
  return {
    title: m.tooltip_derive_title(),
    summary: m.tooltip_derive_summary(),
    sections: [
      { label: m.tooltip_derive_reads(), text: m.tooltip_derive_reads_body() },
      { label: m.tooltip_derive_correct(), text: m.tooltip_derive_correct_body() },
    ],
  };
}

/** Why a task runs where it runs (#2772): the reason, what it needed, who decided — in New Task
 *  before it starts and on its session afterwards. */
export function placementExplanation(p: Placement): TooltipExplanation {
  return {
    title: m.tooltip_placement_title({ machine: p.target.name }),
    summary: placementReason(p),
    sections: [
      {
        label: m.tooltip_placement_needs(),
        text:
          p.requirements.length > 0
            ? capabilityList(p.requirements)
            : m.tooltip_placement_needs_none(),
      },
      {
        label: m.tooltip_placement_how(),
        text:
          p.mode === "manual" ? m.tooltip_placement_how_manual() : m.tooltip_placement_how_auto(),
      },
      { label: m.tooltip_placement_by(), text: p.by.name },
    ],
  };
}

/** That a task never moves on its own (#2775), and where it could run now instead. */
function noFallback(alternatives: readonly SessionHost[] | undefined): string {
  const machines = (alternatives ?? []).map((h) => h.name).join(", ");
  return machines
    ? m.tooltip_waiting_fallback_body({ machines })
    : m.tooltip_waiting_fallback_none();
}

/** A task waiting for the machine it is meant for (#2775): out of reach, or back but blocked —
 *  when it starts, that it never goes elsewhere on its own, and what Cancel and Run on do. */
function waitingExplanation(
  d: Pick<RemoteDispatch, "state" | "host" | "readiness" | "placement" | "alternatives">,
): TooltipExplanation {
  const machine = d.host.name;
  const reason = d.placement ? placementReason(d.placement) : "";
  const fallback = { label: m.tooltip_waiting_fallback(), text: noFallback(d.alternatives) };
  const cancel = {
    label: m.tooltip_dispatch_cancel(),
    text: m.tooltip_waiting_cancel_body({ machine }),
  };
  if (isBlocked(d)) {
    const state = d.readiness?.state;
    const summary =
      state === "missing_capabilities"
        ? m.tooltip_blocked_missing_summary({ machine, list: missingList(d.readiness) })
        : state === "project_missing"
          ? m.tooltip_blocked_project_summary({ machine })
          : m.tooltip_blocked_unreleased_summary({ machine });
    return {
      title: m.tooltip_blocked_title({ machine }),
      summary,
      sections: [
        { label: m.tooltip_blocked_next(), text: m.tooltip_blocked_next_body({ machine }) },
        fallback,
        cancel,
      ],
    };
  }
  const ready = d.readiness?.state === "ready";
  return {
    title: m.tooltip_waiting_title({ machine }),
    summary: ready
      ? m.tooltip_waiting_ready_summary({ machine })
      : m.tooltip_waiting_offline_summary({ machine, reason }),
    sections: [
      ...(ready
        ? []
        : [{ label: m.tooltip_waiting_connection(), text: offlineLabel(d.readiness?.status) }]),
      { label: m.tooltip_waiting_start(), text: m.tooltip_waiting_start_body({ machine }) },
      fallback,
      cancel,
    ],
  };
}

/** A task its machine accepted but holds (#2775): busy there — when it starts, and what Cancel does. */
function heldExplanation(machine: string): TooltipExplanation {
  return {
    title: m.tooltip_held_title({ machine }),
    summary: m.tooltip_held_summary({ machine }),
    sections: [
      { label: m.tooltip_waiting_start(), text: m.tooltip_held_start_body({ machine }) },
      { label: m.tooltip_dispatch_cancel(), text: m.tooltip_held_cancel_body({ machine }) },
      { label: m.tooltip_held_elsewhere(), text: m.tooltip_held_elsewhere_body() },
    ],
  };
}

/** The machine choice's wait (#2775), before a task is submitted: the machine it is meant for is
 *  out of reach, so the task would wait for it. */
export function placementWaitExplanation(p: Placement, wait: PlacementWait): TooltipExplanation {
  const machine = p.target.name;
  return {
    title: m.tooltip_waiting_title({ machine }),
    summary: m.tooltip_waiting_offline_summary({ machine, reason: placementReason(p) }),
    sections: [
      { label: m.tooltip_waiting_connection(), text: offlineLabel(wait.status) },
      { label: m.tooltip_waiting_start(), text: m.tooltip_waiting_start_body({ machine }) },
      { label: m.tooltip_waiting_fallback(), text: noFallback(wait.alternatives) },
    ],
  };
}

/** A task for a connected machine that is not settled: its start is unknown (#2774) — why, what
 *  Shepherd does about it, and what a cancel does — or, once cancelled, what happens until the
 *  machine answers; or it waits for its machine, or is held there (#2775). */
export function remoteDispatchExplanation(
  d: Pick<RemoteDispatch, "state" | "host" | "readiness" | "placement" | "alternatives">,
): TooltipExplanation {
  const machine = d.host.name;
  if (d.state === "waiting") return waitingExplanation(d);
  if (d.state === "held") return heldExplanation(machine);
  if (d.state === "canceling") {
    return {
      title: m.remote_dispatch_canceling(),
      summary: m.tooltip_dispatch_canceling_summary({ machine }),
      sections: [
        { label: m.tooltip_dispatch_until(), text: m.tooltip_dispatch_until_body({ machine }) },
      ],
    };
  }
  return {
    title: m.remote_dispatch_unknown(),
    summary: m.tooltip_dispatch_unknown_summary({ machine }),
    sections: [
      { label: m.tooltip_dispatch_check(), text: m.tooltip_dispatch_check_body({ machine }) },
      { label: m.tooltip_dispatch_once(), text: m.tooltip_dispatch_once_body({ machine }) },
      { label: m.tooltip_dispatch_cancel(), text: m.tooltip_dispatch_cancel_body({ machine }) },
    ],
  };
}

/** A session mirrored from a connected machine (#2762): where it runs, the state of the link, and
 *  why its actions are not offered here. Shared by the machine badge and every disabled action. */
export function remoteSessionExplanation(
  host: SessionHost,
  connection: SessionConnection,
  nowMs: number,
): TooltipExplanation {
  const machine = host.name;
  return {
    title: m.remote_runs_on({ machine }),
    summary: m.tooltip_remote_summary({ machine, platform: platformName(host.platform) }),
    sections: [
      {
        label: m.tooltip_remote_connection(),
        text:
          connection.state === "connected"
            ? m.tooltip_remote_connected_body()
            : m.tooltip_remote_disconnected_body({
                machine,
                time: lastKnownLabel(connection.since, nowMs),
              }),
      },
      { label: m.tooltip_remote_actions(), text: m.tooltip_remote_forwarded_body({ machine }) },
    ],
  };
}

/** What a connected machine reports about one of its sessions (#2762): the task and where it
 *  works. The hover panel on the detail's designator, as the Viewport's meta popover is locally;
 *  why it runs on that machine is the status bar's, so it is not repeated here. */
export function remoteFactsExplanation(
  session: Pick<
    MirroredSession,
    | "name"
    | "status"
    | "prompt"
    | "repoPath"
    | "branch"
    | "baseBranch"
    | "baseCommit"
    | "sandboxDegraded"
    | "host"
  >,
): TooltipExplanation {
  return {
    title: session.name,
    summary: m.remote_runs_on({ machine: session.host.name }),
    sections: [
      { label: m.remote_detail_status(), text: statusLabel(session.status) },
      { label: m.remote_detail_task(), text: session.prompt, full: true },
      { label: m.remote_detail_repo(), text: basename(session.repoPath) },
      { label: m.remote_detail_branch(), text: session.branch ?? session.baseBranch },
      ...(session.baseCommit
        ? [
            {
              label: m.remote_detail_base(),
              text: `${session.baseBranch} @ ${session.baseCommit.slice(0, 7)}`,
            },
          ]
        : []),
      ...(session.sandboxDegraded
        ? [{ label: m.remote_detail_sandbox(), text: m.session_sandbox_degraded_label() }]
        : []),
    ],
  };
}

/** Project bootstrap (#3105): what the hold stops, when it ends, what the override costs. */
export function bootstrapExplanation(): TooltipExplanation {
  return {
    title: m.tooltip_bootstrap_title(),
    summary: m.tooltip_bootstrap_summary(),
    sections: [
      { label: m.tooltip_bootstrap_hold(), text: m.tooltip_bootstrap_hold_body() },
      { label: m.tooltip_bootstrap_exit(), text: m.tooltip_bootstrap_exit_body() },
      { label: m.tooltip_bootstrap_override(), text: m.tooltip_bootstrap_override_body() },
    ],
  };
}
