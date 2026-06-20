<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import InfoTip from "../InfoTip.svelte";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";
  import { modelLabel } from "$lib/model-label";
  import { MODELS, type SandboxProfile } from "$lib/types";

  let {
    planGate = $bindable(),
    research = $bindable(),
    autopilot = $bindable(),
    model = $bindable(),
    sandboxProfile = $bindable(),
    onPlanGateTouched,
    onAutopilotTouched,
    onModelTouched,
    planGateLoading,
    autopilotLoading,
    autopilotDefault,
    repoPath,
    relaunch,
    fableAvailable,
  }: {
    planGate: boolean;
    research: boolean;
    autopilot: boolean;
    model: string;
    sandboxProfile: "default" | SandboxProfile;
    // touched flags live in the parent; the child only signals a manual change
    // (write-only `$bindable` would trip no-useless-assignment here)
    onPlanGateTouched: () => void;
    onAutopilotTouched: () => void;
    onModelTouched: () => void;
    planGateLoading: boolean;
    autopilotLoading: boolean;
    autopilotDefault: boolean;
    repoPath: string;
    relaunch: boolean;
    fableAvailable: boolean;
  } = $props();
</script>

<!-- Per-task run settings. Plan gate gets its own full-width row so its explainer
     reads on one line; Model + Sandbox share a 50/50 row beneath. -->
<div class="opts-row">
  <!-- Each toggle's long explainer now lives behind an InfoTip "i" rather than a
       wrapped hint paragraph — keeps this stack of options compact, which matters
       most on the phone sheet. The InfoTip is a sibling of the <label> (not nested
       inside it) so a tap on the "i" never toggles the checkbox. -->
  <div class="pg-row">
    <label class="plan-gate" use:coachTarget={"plan-gate"}>
      <input
        type="checkbox"
        bind:checked={planGate}
        onchange={() => {
          onPlanGateTouched();
          if (planGate) research = false;
        }}
        disabled={planGateLoading}
      />
      <span class="pg-label">{m.newtask_plan_gate_label()}</span>
    </label>
    {#if planGateLoading}
      <span class="pg-loading">{m.common_loading()}</span>
    {/if}
    <InfoTip
      text={m.newtask_plan_gate_hint()}
      label={m.newtask_info_aria({ topic: m.newtask_plan_gate_label() })}
    />
  </div>

  <!-- Relaunch intentionally CARRIES the original session's autopilot value
       (server-side, src/service.ts relaunch()), so RelaunchOverrides has no
       autopilotEnabled field and the override wouldn't take effect here.
       Hide the control in relaunch so it never implies an override it can't honor. -->
  {#if !relaunch}
    <div class="pg-row">
      <label class="plan-gate" use:coachTarget={"task-autopilot"}>
        <input
          type="checkbox"
          bind:checked={autopilot}
          onchange={() => onAutopilotTouched()}
          disabled={autopilotLoading}
        />
        <span class="pg-label">{m.newtask_autopilot_label()}</span>
      </label>
      <!-- The repo's standing default, shown alongside so it's clear how this repo
           normally handles it — the checkbox is seeded from it on open, so unchecking
           here is a visible, deliberate opt-out for this one task. -->
      {#if autopilotLoading}
        <span class="pg-loading">{m.common_loading()}</span>
      {:else if repoPath}
        <span class="repo-default" class:on={autopilotDefault}>
          {autopilotDefault
            ? m.newtask_autopilot_repo_default_on()
            : m.newtask_autopilot_repo_default_off()}
        </span>
      {/if}
      <InfoTip
        text={m.newtask_autopilot_hint()}
        label={m.newtask_info_aria({ topic: m.newtask_autopilot_label() })}
      />
    </div>
  {/if}

  <div class="pg-row">
    <label class="plan-gate">
      <input
        type="checkbox"
        bind:checked={research}
        onchange={() => {
          if (research) {
            planGate = false;
            // pin touched so a later repo switch doesn't re-seed/re-enable plan-gate while research is active
            onPlanGateTouched();
            autopilot = false;
            // pin touched so a later repo switch doesn't re-seed/re-enable autopilot while research is active
            onAutopilotTouched();
            if (sandboxProfile === "autonomous") sandboxProfile = "default";
          }
        }}
      />
      <span class="pg-label">{m.newtask_research_label()}</span>
    </label>
    <InfoTip
      text={m.newtask_research_hint()}
      label={m.newtask_info_aria({ topic: m.newtask_research_label() })}
    />
  </div>

  <div class="run-config">
    <div class="model-field" use:coachTarget={"model-1m-context"}>
      <label class="micro" for="nt-model">{m.newtask_model_label()}</label>
      <select id="nt-model" bind:value={model} onchange={() => onModelTouched()}>
        <option value="default">{m.newtask_model_default()}</option>
        {#each MODELS as mdl (mdl)}
          {#if mdl !== "fable" || fableAvailable}
            <option value={mdl}>{modelLabel(mdl)}</option>
          {/if}
        {/each}
      </select>
      {#if !fableAvailable}
        <p class="micro">{m.newtask_fable_unavailable()}</p>
      {/if}
    </div>

    <div class="model-field">
      <label class="micro" for="nt-sandbox">{m.newtask_sandbox_label()}</label>
      <select id="nt-sandbox" bind:value={sandboxProfile} title={m.newtask_sandbox_hint()}>
        <option value="default">{m.newtask_sandbox_default()}</option>
        <option value="trusted">{m.sandbox_profile_trusted()}</option>
        <option value="standard">{m.sandbox_profile_standard()}</option>
        <option value="autonomous" disabled={research}>{m.sandbox_profile_autonomous()}</option>
      </select>
      {#if research}
        <span class="pg-hint">{m.newtask_research_sandbox_note()}</span>
      {/if}
    </div>
  </div>
</div>

<style>
  /* Field primitives shared with the parent composer — duplicated here so the moved
     <input>/<select>s keep their styling (the parent keeps its copy for its fields). */
  input,
  select {
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    color: var(--color-ink-bright);
    font: inherit;
    font-size: var(--fs-base);
    padding: 8px 10px;
    border-radius: 2px;
    width: 100%;
    box-sizing: border-box;
  }
  select {
    appearance: none;
    cursor: pointer;
  }
  input:focus,
  select:focus {
    outline: none;
    border-color: var(--color-line-bright);
  }
  /* Shared utility — duplicated (the parent keeps its copy for its own labels). */
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
    margin-top: 6px;
  }
  .opts-row {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: 10px;
  }
  /* One toggle: the label (checkbox + name) plus its trailing InfoTip / repo-default
     badge, laid out on a single baseline-centered line. */
  .pg-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .plan-gate {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
  }
  .pg-loading {
    flex: 0 0 auto;
    font-size: var(--fs-micro);
    color: var(--color-muted);
  }
  /* Standing repo default for autopilot — a quiet pill; amber when "on" to echo the
     checkbox accent (green is reserved for actionable-complete per the design system). */
  .repo-default {
    flex: 0 0 auto;
    font-size: var(--fs-micro);
    letter-spacing: 0.04em;
    color: var(--color-muted);
    border: 1px solid var(--color-line);
    border-radius: 999px;
    padding: 1px 8px;
    white-space: nowrap;
  }
  .repo-default.on {
    color: var(--color-amber);
    border-color: var(--color-amber);
  }
  .run-config {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
  }
  .model-field {
    flex: 1 1 0;
    min-width: 120px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .model-field .micro {
    margin-top: 0;
  }
  .plan-gate input {
    width: auto;
    flex: 0 0 auto;
    accent-color: var(--color-amber);
  }
  .plan-gate:has(input:disabled) {
    cursor: progress;
    opacity: 0.6;
  }
  .pg-label {
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
  }
  .pg-hint {
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }
</style>
