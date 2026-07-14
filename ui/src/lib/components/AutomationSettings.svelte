<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { reviews, repoConfig, planGates } from "$lib/reviews.svelte";
  import { infoTips } from "$lib/info-tips.svelte";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";
  import { getSettings } from "$lib/api";
  import { DOCS_URL } from "$lib/build-info";
  import AutomationInfoTip from "./automation-settings/AutomationInfoTip.svelte";
  import AutomationDetail from "./automation-settings/AutomationDetail.svelte";
  import AutomationRepoFields from "./automation-settings/AutomationRepoFields.svelte";
  import AutomationDrainFields from "./automation-settings/AutomationDrainFields.svelte";
  import "./automation-settings/automation-fields.css";
  import { onMount } from "svelte";
  import type { Session, SandboxProfile, DrainStatus } from "$lib/types";

  let {
    repoPath,
    sessionId,
    planPhase = null,
    drain = null,
    showHeader = true,
    armCoachmarks = false,
  }: {
    repoPath: string;
    /** Per-task session id — drives the critic/plan-gate switch-pulse. Absent on the
     *  task-independent backlog surface, where no review is ever in flight. */
    sessionId?: string;
    planPhase?: Session["planPhase"];
    /** Live drain status for this repo; passed from the host (GitRail or BacklogView).
     *  When drain.epicParent is set, label-drain is suspended by the active epic. */
    drain?: DrainStatus | null;
    /** Render the in-body title/subtitle. Suppressed on the backlog tab, where the
     *  "Automation" tab label already names the surface. */
    showHeader?: boolean;
    /** Register the coach-target anchors (lightweight-repo / draft-mode / sandbox-profile).
     *  Only the in-task popover arms them — coachTargets keys one node per id and an
     *  unmount deletes it, so a second mounted instance must NOT register or it would
     *  orphan the other instance's anchors on teardown. */
    armCoachmarks?: boolean;
  } = $props();

  // Coach-target wrapper gated on `armCoachmarks`. The popover passes true; the
  // backlog tab leaves it false so only the in-task instance ever registers.
  function coachIf(node: HTMLElement, args: { id: string; on: boolean }) {
    if (!args.on) return;
    return coachTarget(node, args.id);
  }

  /** True when a running epic has taken over label-drain for this repo. */
  const epicActive = $derived(drain?.epicParent != null);

  const flags = $derived(repoConfig.flags(repoPath));
  /** True when this repo is configured for local-only (lightweight) mode. */
  const lightweight = $derived(repoConfig.repoModeFor(repoPath) === "lightweight");
  /** Auto-Drain's rails are live only when drain is on, not epic-suspended, and the
   *  repo is a forge — mirrors the Auto-Drain switch's own enabled condition. */
  const drainRailsActive = $derived(flags.autoDrain && !epicActive && !lightweight);
  // Switch-pulse is per-task; only meaningful when this instance is bound to a session.
  const reviewing = $derived(sessionId ? reviews.isReviewing(sessionId) : false);
  const planReviewing = $derived(sessionId ? planGates.isReviewing(sessionId) : false);
  let fableAvailable = $state(true);

  onMount(async () => {
    try {
      fableAvailable = (await getSettings()).fableAvailable;
    } catch {
      // Fail open: this is guidance only, and the spawn path still enforces availability.
    }
  });

  // Derived row state for the dependency-gated switches, hoisted out of the template so the
  // markup stays flat (keeps the <template> under the Tier-1 complexity bar). Manual-steps
  // opens a GitHub issue on merge → needs a forge, so it's unavailable in lightweight mode.
  // Auto-optimize rewrites injected house-rules → moot when Learnings injection is off.
  const lightweightTip = $derived(lightweight ? m.automation_lightweight_unavailable() : undefined);
  const manualStepsActive = $derived(repoConfig.manualStepsIssueOn(repoPath) && !lightweight);
  const preWarmEpicCiActive = $derived(repoConfig.preWarmEpicLandingCiOn(repoPath) && !lightweight);
  const autoOptimizeActive = $derived(repoConfig.autoOptimizeOn(repoPath) && flags.learnings);
  const signoffAuthority = $derived(repoConfig.signoffAuthorityFor(repoPath));
  const signoffHelp = $derived(
    signoffAuthority === "human"
      ? m.automation_signoff_human_help()
      : signoffAuthority === "critic"
        ? m.automation_signoff_critic_help()
        : m.automation_signoff_either_help(),
  );
  const autoOptimizeDesc = $derived(
    flags.learnings
      ? m.settings_auto_optimize_flagged_help()
      : m.automation_autooptimize_needs_learnings(),
  );

  // Which row's long-form "ⓘ" explanation is currently expanded. One at a time —
  // this panel is a narrow popover, so a single open detail keeps it readable.
  let openDetail = $state<string | null>(null);
  const toggleDetail = (id: string) => (openDetail = openDetail === id ? null : id);

  // Collapse any expanded explanation when the operator hides info tips. `openDetail` is
  // component-local state that survives the preference flip without a remount, so without
  // this a row that was open would keep its detail expanded with no ⓘ left to close it.
  // AutomationDetail also drops itself when tips are hidden, so this reset is not
  // load-bearing for correctness — it's what makes re-enabling tips later return a cleanly
  // collapsed panel rather than a stale expansion.
  $effect(() => {
    if (infoTips.hidden) openDetail = null;
  });

  // The panel's switches are repo-level defaults; the plan gate is also a per-task
  // one-shot set at creation. Surface THIS task's actual gate phase so a tick in
  // New Task doesn't read as "off" just because the repo default is off. Shown only
  // when the task is genuinely gated — an ungated task needs no line (the repo-wide
  // subtitle already explains the switch is a default).
  const planGateTaskLabel = $derived(
    planPhase === "planning"
      ? m.automation_plan_gate_task_planning()
      : m.automation_plan_gate_task_executing(),
  );
</script>

{#if showHeader}
  <div class="auto-head">{m.automation_panel_title()}</div>
  <div class="auto-sub">{m.automation_panel_subtitle()}</div>
  <!-- eslint-disable svelte/no-navigation-without-resolve -- external docs URL -->
  <a
    class="auto-guide"
    href={`${DOCS_URL}hands-off-epics/`}
    target="_blank"
    rel="noopener noreferrer"
  >
    {m.automation_handsoff_hint()}
  </a>
  <!-- eslint-enable svelte/no-navigation-without-resolve -->
{/if}

<!-- Repo mode: lightweight (local-only) vs forge (GitHub/PRs) -->
<div class="auto-row" use:coachIf={{ id: "lightweight-repo", on: armCoachmarks }}>
  <div class="auto-meta">
    <div class="auto-name">
      ⊙ {m.automation_lightweight_name()}
      <AutomationInfoTip
        id="lightweight"
        name={m.automation_lightweight_name()}
        open={openDetail === "lightweight"}
        ontoggle={() => toggleDetail("lightweight")}
      />
    </div>
    <div class="auto-desc">{m.automation_lightweight_desc()}</div>
    <AutomationDetail
      id="lightweight"
      open={openDetail === "lightweight"}
      paragraphs={[m.automation_lightweight_detail()]}
    />
  </div>
  <button
    class={["sw", { on: lightweight }]}
    type="button"
    role="switch"
    aria-checked={lightweight}
    aria-label={m.automation_lightweight_name()}
    onclick={() => repoConfig.setRepoMode(repoPath, lightweight ? "forge" : "lightweight")}
  >
    <span class="knob"></span>
  </button>
</div>

<!-- Code review -->
<div class="auto-group">{m.automation_group_review()}</div>
<div class="auto-row">
  <div class="auto-meta">
    <div class="auto-name">
      ⌕ {m.automation_critic_name()}
      <AutomationInfoTip
        id="critic"
        name={m.automation_critic_name()}
        open={openDetail === "critic"}
        ontoggle={() => toggleDetail("critic")}
      />
    </div>
    <div class="auto-desc">{m.automation_critic_desc()}</div>
    <AutomationDetail
      id="critic"
      open={openDetail === "critic"}
      paragraphs={[m.automation_critic_detail()]}
    />
  </div>
  <button
    class={["sw", { on: flags.critic, reviewing }]}
    type="button"
    role="switch"
    aria-checked={flags.critic}
    aria-busy={reviewing}
    aria-label={m.automation_critic_name()}
    onclick={() => repoConfig.toggle(repoPath)}
  >
    <span class="knob"></span>
  </button>
</div>
<div class={["auto-row", { disabled: lightweight }]}>
  <div class="auto-meta">
    <div class="auto-name">
      ⌗ {m.automation_allprs_name()}
      <AutomationInfoTip
        id="critic-all-prs"
        name={m.automation_allprs_name()}
        open={openDetail === "critic-all-prs"}
        ontoggle={() => toggleDetail("critic-all-prs")}
      />
    </div>
    <div class="auto-desc">{m.automation_allprs_desc()}</div>
    <AutomationDetail
      id="critic-all-prs"
      open={openDetail === "critic-all-prs"}
      paragraphs={[m.automation_allprs_detail()]}
    />
  </div>
  <button
    class={["sw", { on: flags.criticAllPrs && !lightweight }]}
    type="button"
    role="switch"
    aria-checked={flags.criticAllPrs && !lightweight}
    disabled={lightweight}
    title={lightweight ? m.automation_lightweight_unavailable() : undefined}
    aria-label={m.automation_allprs_name()}
    onclick={() => !lightweight && repoConfig.toggleAllPrs(repoPath)}
  >
    <span class="knob"></span>
  </button>
</div>
<div class={["auto-row", { disabled: !flags.critic }]}>
  <div class="auto-meta">
    <div class="auto-name">
      ◆ {m.automation_autoaddress_name()}
      <AutomationInfoTip
        id="auto-address"
        name={m.automation_autoaddress_name()}
        open={openDetail === "auto-address"}
        ontoggle={() => toggleDetail("auto-address")}
      />
    </div>
    <div class="auto-desc">
      {flags.critic ? m.automation_autoaddress_desc() : m.automation_autoaddress_needs_critic()}
    </div>
    <AutomationDetail
      id="auto-address"
      open={openDetail === "auto-address"}
      paragraphs={[m.automation_autoaddress_detail()]}
    />
  </div>
  <button
    class={["sw", { on: flags.autoAddress && flags.critic }]}
    type="button"
    role="switch"
    aria-checked={flags.autoAddress && flags.critic}
    disabled={!flags.critic}
    aria-label={m.automation_autoaddress_name()}
    onclick={() => repoConfig.toggleAutoAddress(repoPath)}
  >
    <span class="knob"></span>
  </button>
</div>
<div class="auto-row">
  <div class="auto-meta">
    <div class="auto-name">
      ⌖ {m.automation_plan_gate_name()}
      <AutomationInfoTip
        id="plan-gate"
        name={m.automation_plan_gate_name()}
        open={openDetail === "plan-gate"}
        ontoggle={() => toggleDetail("plan-gate")}
      />
    </div>
    <div class="auto-desc">{m.automation_plan_gate_desc()}</div>
    {#if planPhase != null}
      <div class="auto-task">{planGateTaskLabel}</div>
    {/if}
    <AutomationDetail
      id="plan-gate"
      open={openDetail === "plan-gate"}
      paragraphs={[m.automation_plan_gate_detail()]}
    />
  </div>
  <button
    class={["sw", { on: flags.planGate, reviewing: planReviewing }]}
    type="button"
    role="switch"
    aria-checked={flags.planGate}
    aria-busy={planReviewing}
    aria-label={m.automation_plan_gate_name()}
    onclick={() => repoConfig.togglePlanGate(repoPath)}
  >
    <span class="knob"></span>
  </button>
</div>

<!-- Agent behavior -->
<div class="auto-group">{m.automation_group_behavior()}</div>
<div class="auto-row">
  <div class="auto-meta">
    <div class="auto-name">
      ✦ {m.automation_learnings_name()}
      <AutomationInfoTip
        id="learnings"
        name={m.automation_learnings_name()}
        open={openDetail === "learnings"}
        ontoggle={() => toggleDetail("learnings")}
      />
    </div>
    <div class="auto-desc">{m.automation_learnings_desc()}</div>
    <AutomationDetail
      id="learnings"
      open={openDetail === "learnings"}
      paragraphs={[m.automation_learnings_detail()]}
    />
  </div>
  <button
    class={["sw", { on: flags.learnings }]}
    type="button"
    role="switch"
    aria-checked={flags.learnings}
    aria-label={m.automation_learnings_name()}
    onclick={() => repoConfig.toggleLearnings(repoPath)}
  >
    <span class="knob"></span>
  </button>
</div>
<div class={["auto-row", { disabled: !flags.learnings }]}>
  <div class="auto-meta">
    <div class="auto-name">
      ⟳ {m.settings_auto_optimize_flagged_label()}
    </div>
    <div class="auto-desc">{autoOptimizeDesc}</div>
  </div>
  <button
    class={["sw", { on: autoOptimizeActive }]}
    type="button"
    role="switch"
    aria-checked={autoOptimizeActive}
    disabled={!flags.learnings}
    aria-label={m.settings_auto_optimize_flagged_label()}
    onclick={() => repoConfig.toggleAutoOptimize(repoPath)}
  >
    <span class="knob"></span>
  </button>
</div>
<div class={["auto-row", { disabled: lightweight }]}>
  <div class="auto-meta">
    <div class="auto-name">☑ {m.automation_manual_steps_issue_name()}</div>
    <div class="auto-desc">{m.automation_manual_steps_issue_desc()}</div>
  </div>
  <button
    class={["sw", { on: manualStepsActive }]}
    type="button"
    role="switch"
    aria-checked={manualStepsActive}
    disabled={lightweight}
    title={lightweightTip}
    aria-label={m.automation_manual_steps_issue_name()}
    onclick={() => repoConfig.toggleManualStepsIssue(repoPath)}
  >
    <span class="knob"></span>
  </button>
</div>
<div class="auto-row">
  <div class="auto-meta">
    <div class="auto-name">
      ▲ {m.automation_autopilot_name()}
      <AutomationInfoTip
        id="autopilot"
        name={m.automation_autopilot_name()}
        open={openDetail === "autopilot"}
        ontoggle={() => toggleDetail("autopilot")}
      />
    </div>
    <div class="auto-desc">{m.automation_autopilot_desc()}</div>
    <AutomationDetail
      id="autopilot"
      open={openDetail === "autopilot"}
      paragraphs={[m.automation_autopilot_detail()]}
    />
  </div>
  <button
    class={["sw", { on: flags.autopilot }]}
    type="button"
    role="switch"
    aria-checked={flags.autopilot}
    aria-label={m.automation_autopilot_name()}
    onclick={() => repoConfig.toggleAutopilot(repoPath)}
  >
    <span class="knob"></span>
  </button>
</div>

<!-- Work queue -->
<div class="auto-group">{m.automation_group_queue()}</div>
{#if epicActive}
  <div class="epic-mode-banner" role="status">
    ◈ {m.epic_mode_active({ parent: drain!.epicParent! })}
  </div>
{/if}
<div class={["auto-row", { disabled: epicActive || lightweight }]}>
  <div class="auto-meta">
    <div class="auto-name">
      ▽ {m.automation_autodrain_name()}
      <AutomationInfoTip
        id="auto-drain"
        name={m.automation_autodrain_name()}
        open={openDetail === "auto-drain"}
        ontoggle={() => toggleDetail("auto-drain")}
      />
    </div>
    <div class="auto-desc">{m.automation_autodrain_desc()}</div>
    <AutomationDetail
      id="auto-drain"
      open={openDetail === "auto-drain"}
      paragraphs={[m.automation_autodrain_detail()]}
    />
  </div>
  <button
    class={["sw", { on: flags.autoDrain && !epicActive && !lightweight }]}
    type="button"
    role="switch"
    aria-checked={flags.autoDrain && !epicActive && !lightweight}
    disabled={epicActive || lightweight}
    title={lightweight
      ? m.automation_lightweight_unavailable()
      : epicActive
        ? m.epic_mode_active({ parent: drain!.epicParent! })
        : undefined}
    aria-label={m.automation_autodrain_name()}
    onclick={() => !(epicActive || lightweight) && repoConfig.toggleAutoDrain(repoPath)}
  >
    <span class="knob"></span>
  </button>
</div>
<!-- Auto-Drain's rails (cap / label / usage ceiling), inline directly under its
     toggle so they read as part of that switch. The component renders them only
     while drain is genuinely active (on, not epic-suspended, forge repo) —
     visibility is gated inside it via `active` so this template stays flat. -->
<AutomationDrainFields {repoPath} active={drainRailsActive} />
<div class={["auto-row", { disabled: lightweight }]}>
  <div class="auto-meta">
    <div class="auto-name">☑ {m.automation_prewarm_epic_ci_name()}</div>
    <div class="auto-desc">{m.automation_prewarm_epic_ci_desc()}</div>
  </div>
  <button
    class={["sw", { on: preWarmEpicCiActive }]}
    type="button"
    role="switch"
    aria-checked={preWarmEpicCiActive}
    disabled={lightweight}
    title={lightweightTip}
    aria-label={m.automation_prewarm_epic_ci_name()}
    onclick={() => repoConfig.togglePreWarmEpicLandingCi(repoPath)}
  >
    <span class="knob"></span>
  </button>
</div>
<div class={["auto-row", { disabled: flags.draftMode }]}>
  <div class="auto-meta">
    <div class="auto-name">
      ↣ {m.automation_automerge_name()}
      <AutomationInfoTip
        id="auto-merge"
        name={m.automation_automerge_name()}
        open={openDetail === "auto-merge"}
        ontoggle={() => toggleDetail("auto-merge")}
      />
    </div>
    <div class="auto-desc">
      {flags.draftMode
        ? m.automation_draftmode_excludes_automerge()
        : m.automation_automerge_desc()}
    </div>
    <AutomationDetail
      id="auto-merge"
      open={openDetail === "auto-merge"}
      paragraphs={[m.automation_automerge_detail()]}
    />
  </div>
  <button
    class={["sw", { on: flags.autoMerge && !flags.draftMode }]}
    type="button"
    role="switch"
    aria-checked={flags.autoMerge && !flags.draftMode}
    disabled={flags.draftMode}
    title={flags.draftMode ? m.automation_draftmode_excludes_automerge() : undefined}
    aria-label={m.automation_automerge_name()}
    onclick={() => repoConfig.toggleAutoMerge(repoPath)}
  >
    <span class="knob"></span>
  </button>
</div>
<div class="auto-row">
  <div class="auto-meta">
    <div class="auto-name">
      ▦ {m.automation_buildqueue_name()}
      <AutomationInfoTip
        id="build-queue"
        name={m.automation_buildqueue_name()}
        open={openDetail === "build-queue"}
        ontoggle={() => toggleDetail("build-queue")}
      />
    </div>
    <div class="auto-desc">{m.automation_buildqueue_desc()}</div>
    <AutomationDetail
      id="build-queue"
      open={openDetail === "build-queue"}
      paragraphs={[m.automation_buildqueue_detail()]}
    />
  </div>
  <button
    class={["sw", { on: flags.buildQueue }]}
    type="button"
    role="switch"
    aria-checked={flags.buildQueue}
    aria-label={m.automation_buildqueue_name()}
    onclick={() => repoConfig.toggleBuildQueue(repoPath)}
  >
    <span class="knob"></span>
  </button>
</div>
<div
  class={["auto-row", { disabled: flags.autoMerge || lightweight }]}
  use:coachIf={{ id: "draft-mode", on: armCoachmarks }}
>
  <div class="auto-meta">
    <div class="auto-name">□ {m.automation_draftmode_name()}</div>
    <div class="auto-desc">
      {flags.autoMerge
        ? m.automation_draftmode_excludes_automerge()
        : m.automation_draftmode_desc()}
    </div>
  </div>
  <button
    class={["sw", { on: flags.draftMode && !flags.autoMerge && !lightweight }]}
    type="button"
    role="switch"
    aria-checked={flags.draftMode && !flags.autoMerge && !lightweight}
    disabled={flags.autoMerge || lightweight}
    title={lightweight
      ? m.automation_lightweight_unavailable()
      : flags.autoMerge
        ? m.automation_draftmode_excludes_automerge()
        : undefined}
    aria-label={m.automation_draftmode_name()}
    onclick={() => !(flags.autoMerge || lightweight) && repoConfig.toggleDraftMode(repoPath)}
  >
    <span class="knob"></span>
  </button>
</div>
{#if flags.draftMode}
  <div class="drain-fields">
    <label class="drain-field">
      <span class="drain-label">{m.automation_signoff_authority_label()}</span>
      <select
        class="afield-num signoff-select"
        aria-label={m.automation_signoff_authority_label()}
        value={signoffAuthority}
        onchange={(e) =>
          repoConfig.setSignoffAuthority(
            repoPath,
            (e.currentTarget as HTMLSelectElement).value as "human" | "critic" | "either",
          )}
      >
        <option value="human">{m.signoff_authority_human()}</option>
        <!-- Critic-reliant authorities are unusable with the Critic off (they could never
             promote a draft → permanent-draft deadlock), so disable them. -->
        <option value="critic" disabled={!flags.critic}>{m.signoff_authority_critic()}</option>
        <option value="either" disabled={!flags.critic}>{m.signoff_authority_either()}</option>
      </select>
    </label>
    <div class="signoff-note">{signoffHelp}</div>
    {#if !flags.critic}
      <div class="signoff-note">{m.automation_signoff_needs_critic()}</div>
    {/if}
  </div>
{/if}

<!-- Sandbox confinement: a repo-wide default, independent of any switch above.
     Opt-in (trusted = today's unconfined behavior); autonomous is required for
     auto/drain sessions. -->
<div class="drain-fields">
  <label class="drain-field" use:coachIf={{ id: "sandbox-profile", on: armCoachmarks }}>
    <span class="drain-label">{m.automation_sandbox_profile_label()}</span>
    <select
      class="afield-num sandbox-select"
      aria-label={m.automation_sandbox_profile_label()}
      value={repoConfig.sandboxProfileFor(repoPath)}
      onchange={(e) =>
        repoConfig.setSandboxProfile(
          repoPath,
          (e.currentTarget as HTMLSelectElement).value as SandboxProfile,
        )}
    >
      <option value="trusted">{m.sandbox_profile_trusted()}</option>
      <option value="standard">{m.sandbox_profile_standard()}</option>
      <option value="autonomous">{m.sandbox_profile_autonomous()}</option>
    </select>
  </label>
  <div class="signoff-note sandbox-summary">
    {m.automation_sandbox_profile_summary()}
    <AutomationInfoTip
      id="sandbox"
      name={m.automation_sandbox_profile_label()}
      open={openDetail === "sandbox"}
      ontoggle={() => toggleDetail("sandbox")}
    />
  </div>
  <AutomationDetail
    id="sandbox"
    open={openDetail === "sandbox"}
    paragraphs={[m.automation_sandbox_profile_hint(), m.automation_sandbox_profile_caveats()]}
    sandbox
  />
</div>

<AutomationRepoFields {repoPath} {fableAvailable} />

<style>
  .auto-head {
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-muted);
    padding: 10px 12px 2px;
  }
  .auto-sub {
    font-size: var(--fs-meta);
    color: var(--color-faint);
    padding: 0 12px 6px;
  }
  .auto-guide {
    display: block;
    font-size: var(--fs-micro);
    color: var(--color-blue);
    text-decoration: none;
    padding: 0 12px 8px;
  }
  .auto-guide:hover {
    text-decoration: underline;
  }
  .auto-group {
    font-size: var(--fs-micro);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--color-amber);
    padding: 8px 12px 4px;
  }
  .auto-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
    padding: 8px 12px;
    border-top: 1px solid var(--color-line);
  }
  .auto-row.disabled {
    opacity: 0.45;
  }
  .auto-meta {
    min-width: 0;
  }
  .auto-name {
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-mono);
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
  }
  /* clickable "ⓘ" — small circular affordance that toggles the long explanation */
  /* the revealed long-form explanation: a quiet tonal-step note (panel over the
     popover's inset ground) with a full hairline border — no accent stripe */
  .auto-desc {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    margin-top: 2px;
  }
  /* per-task plan-gate reality: amber, shown only when this task is actually gated
     — so a New Task tick reads as active even when the repo default is off */
  .auto-task {
    font-size: var(--fs-micro);
    color: var(--color-amber);
    margin-top: 3px;
  }
  /* switch: track + knob, amber when on (active mode, not a completion —
     Four-Light Rule), pulsing while actively reviewing */
  .sw {
    flex: 0 0 auto;
    margin-top: 2px;
    width: 30px;
    height: 17px;
    /* squared track + knob (2px, instrument hardware) — never pill-shaped */
    border-radius: 2px;
    border: 1px solid var(--color-line);
    background: var(--color-faint);
    position: relative;
    cursor: pointer;
    padding: 0;
    transition: background 0.12s;
  }
  .sw:disabled {
    cursor: not-allowed;
  }
  .sw .knob {
    position: absolute;
    top: 1px;
    left: 1px;
    width: 13px;
    height: 13px;
    border-radius: 2px;
    background: var(--color-slate);
    transition:
      left 0.12s,
      background 0.12s;
  }
  .sw.on {
    background: var(--color-amber);
  }
  .sw.on .knob {
    left: 15px;
    background: var(--color-inset);
  }
  .sw.reviewing {
    background: var(--color-amber);
    /* functional status motion — exempt from the reduced-motion blanket (app.css) */
    animation: sw-pulse 1.1s ease-in-out infinite !important;
  }
  @keyframes sw-pulse {
    0%,
    100% {
      opacity: 0.45;
    }
    50% {
      opacity: 1;
    }
  }
  /* .drain-fields / .drain-field / .drain-label / .afield-num come from
     ./automation-settings/automation-fields.css (imported in <script>). */
  /* Sign-off authority selector — inherits .afield-num token styling, left-aligned */
  .signoff-select {
    flex: 1 1 auto;
    width: auto;
    min-width: 0;
    text-align: left;
    cursor: pointer;
    appearance: auto;
  }
  .signoff-note {
    font-size: var(--fs-meta);
    color: var(--color-faint);
    padding: 0 12px 6px;
  }
  /* Sandbox-profile selector — inherits .afield-num token styling, left-aligned (mirrors .signoff-select) */
  .sandbox-select {
    flex: 1 1 auto;
    width: auto;
    min-width: 0;
    text-align: left;
    cursor: pointer;
    appearance: auto;
  }
  /* Sandbox summary line: flex so the circular ⓘ vertically centers against the
     text (mirrors .auto-name), instead of sitting baseline-misaligned. */
  .sandbox-summary {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  /* Sandbox ⓘ detail: recess to --color-inset so it steps against the
     --color-panel .drain-fields ground (panel-over-panel would show no fill
     step — only the border). margin-top:0 cancels the .auto-detail 6px that
     would otherwise stack on .drain-fields' 6px gap. */
  /* Epic-mode precedence banner: unmistakable amber notice inside the Work queue
     section that label-drain is suspended while an epic runs. Sits above the
     auto-drain row (which is also dimmed via .auto-row.disabled). */
  .epic-mode-banner {
    margin: 0 12px 4px;
    padding: 5px 8px;
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    color: var(--status-running);
    background: color-mix(in oklab, var(--status-running) 12%, transparent);
    border: 1px solid var(--status-running);
    border-radius: 2px;
    line-height: 1.4;
  }
</style>
