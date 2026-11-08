<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { repoConfig, planGates } from "#lib/reviews.svelte.js";
  import type { DrainStatus, Session } from "#lib/types.js";
  import RepoSettingRow from "./RepoSettingRow.svelte";
  import AutomationDrainFields from "../automation-settings/AutomationDrainFields.svelte";
  import AutomationBootstrap from "../automation-settings/AutomationBootstrap.svelte";
  import { drainRailsActive, drainSandboxHeld } from "./drain-hold";

  // Start & flow (#3443): how work starts and runs — the backlog drain and its rails, project
  // bootstrap, the plan gate, the build queue and autopilot.
  let {
    repoPath,
    sessionId,
    planPhase = null,
    drain = null,
  }: {
    repoPath: string;
    /** The task the window was opened from: its plan-gate review pulses the switch. */
    sessionId?: string;
    /** That task's plan-gate phase; null when it isn't gated. */
    planPhase?: Session["planPhase"];
    /** When drain.epicParent is set, label-drain is suspended by the active epic. */
    drain?: DrainStatus | null;
  } = $props();

  const flags = $derived(repoConfig.flags(repoPath));
  const lightweight = $derived(repoConfig.repoModeFor(repoPath) === "lightweight");
  const epicParent = $derived(drain?.epicParent ?? null);
  const epicActive = $derived(epicParent != null);
  const drainOff = $derived(epicActive || lightweight);
  const drainTitle = $derived(
    lightweight
      ? m.automation_lightweight_unavailable()
      : epicParent != null
        ? m.epic_mode_active({ parent: epicParent })
        : undefined,
  );
  const planReviewing = $derived(sessionId ? planGates.isReviewing(sessionId) : false);
  // The switch is a repo default; the plan gate is also a per-task one-shot set at creation, so a
  // gated task says its own phase — a New Task tick then doesn't read as "off".
  const planGateTask = $derived(
    planPhase == null
      ? ""
      : planPhase === "planning"
        ? m.automation_plan_gate_task_planning()
        : m.automation_plan_gate_task_executing(),
  );
</script>

{#if epicParent != null}
  <div class="epic-mode-banner" role="status">◈ {m.epic_mode_active({ parent: epicParent })}</div>
{/if}
<RepoSettingRow
  field="autoDrainEnabled"
  glyph="▽"
  name={m.automation_autodrain_name()}
  desc={m.automation_autodrain_desc()}
  detail={{
    id: "auto-drain",
    intro: m.automation_autodrain_detail_intro(),
    sections: [
      {
        title: m.automation_autodrain_detail_backlog_title(),
        text: m.automation_autodrain_detail_backlog(),
      },
      {
        title: m.automation_autodrain_detail_landing_title(),
        text: m.automation_autodrain_detail_landing(),
      },
      {
        title: m.automation_autodrain_detail_off_title(),
        text: m.automation_autodrain_detail_off(),
      },
      {
        title: m.automation_autodrain_detail_limits_title(),
        text: m.automation_autodrain_detail_limits(),
      },
    ],
  }}
  warn={m.automation_autodrain_sandbox_held()}
  warnShown={drainSandboxHeld(repoPath, drain)}
  disabled={drainOff}
  disabledTitle={drainTitle}
  checked={flags.autoDrain && !drainOff}
  ontoggle={() => repoConfig.toggleAutoDrain(repoPath)}
/>
<!-- The rails (cap / label / usage ceiling) stay while an epic runs: both cap and ceiling are
     still enforced against its children; only the label field hides then. -->
<AutomationDrainFields {repoPath} active={drainRailsActive(repoPath, drain)} {epicActive} />
<AutomationBootstrap {repoPath} />
<RepoSettingRow
  field="planGateEnabled"
  glyph="⌖"
  name={m.automation_plan_gate_name()}
  desc={m.automation_plan_gate_desc()}
  detail={{ id: "plan-gate", text: m.automation_plan_gate_detail() }}
  task={planGateTask}
  checked={flags.planGate}
  busy={planReviewing}
  ontoggle={() => repoConfig.togglePlanGate(repoPath)}
/>
<RepoSettingRow
  field="buildQueueEnabled"
  glyph="▦"
  name={m.automation_buildqueue_name()}
  desc={m.automation_buildqueue_desc()}
  detail={{ id: "build-queue", text: m.automation_buildqueue_detail() }}
  checked={flags.buildQueue}
  ontoggle={() => repoConfig.toggleBuildQueue(repoPath)}
/>
<RepoSettingRow
  field="autopilotEnabled"
  glyph="▲"
  name={m.automation_autopilot_name()}
  desc={m.automation_autopilot_desc()}
  detail={{ id: "autopilot", text: m.automation_autopilot_detail() }}
  checked={flags.autopilot}
  ontoggle={() => repoConfig.toggleAutopilot(repoPath)}
/>

<style>
  /* Epic-mode precedence banner: unmistakable notice that label-drain is suspended while an epic
     runs. Sits above the drain row (which is also dimmed). */
  .epic-mode-banner {
    margin: 4px 12px;
    padding: 5px 8px;
    font-size: var(--fs-meta);
    color: var(--status-running);
    background: color-mix(in oklab, var(--status-running) 12%, transparent);
    border: 1px solid var(--status-running);
    border-radius: 2px;
    line-height: 1.4;
  }
</style>
