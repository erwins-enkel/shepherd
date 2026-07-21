<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";
  import { modelOptionLabel } from "$lib/model-guidance";
  import ModelGuidance from "$lib/components/ModelGuidance.svelte";
  import GlossaryText from "$lib/components/GlossaryText.svelte";
  import EngineCapacityLine from "./EngineCapacityLine.svelte";
  import InstrumentToggle from "./InstrumentToggle.svelte";
  import {
    AGENT_PROVIDERS,
    type AgentProvider,
    type ProviderTokenConstraint,
    type SandboxProfile,
    type UsageLimits,
  } from "$lib/types";
  import { providerModels } from "$lib/provider-models";
  import { providerEfforts, effortLabel } from "$lib/effort-guidance";

  // The single settings-content owner: ENGINE + GUARDS groups, rendered in the desktop
  // rail or inside the mobile engine sheet — exactly one instance is mounted at a time
  // (MediaQuery-switched in NewTask).
  //
  // PRESENTATIONAL INVARIANT (reviewed): this component contains zero $effect blocks
  // and never rewrites model/effort/provider — it renders current values and reports
  // picks via callbacks. All reseeding/normalization lives in NewTask (run-config.ts),
  // so mounting state can never influence payload validity.
  let {
    agentProvider,
    model,
    effort,
    sandboxProfile,
    planGate,
    autopilot,
    modeLocked,
    planGateLoading,
    autopilotLoading,
    planGateDefault,
    autopilotDefault,
    usageLimits = null,
    holdLikely,
    fableAvailable,
    providerConstraint = null,
    research,
    onProviderChange,
    onModelChange,
    onEffortChange,
    onSandboxChange,
    onPlanGateChange,
    onAutopilotChange,
  }: {
    agentProvider: AgentProvider;
    model: string;
    effort: string;
    sandboxProfile: "default" | SandboxProfile;
    planGate: boolean;
    autopilot: boolean;
    /** Research/epic mode: guards + autonomous sandbox render locked. */
    modeLocked: boolean;
    planGateLoading: boolean;
    autopilotLoading: boolean;
    planGateDefault: boolean;
    autopilotDefault: boolean;
    usageLimits?: UsageLimits | null;
    holdLikely: boolean;
    fableAvailable: boolean;
    providerConstraint?: ProviderTokenConstraint | null;
    research: boolean;
    onProviderChange: (provider: AgentProvider) => void;
    onModelChange: (model: string) => void;
    onEffortChange: (effort: string) => void;
    onSandboxChange: (profile: "default" | SandboxProfile) => void;
    onPlanGateChange: (checked: boolean) => void;
    onAutopilotChange: (checked: boolean) => void;
  } = $props();

  const provModels = $derived(providerModels(agentProvider));
  const provEfforts = $derived(providerEfforts(agentProvider));
  let alphaExpanded = $state(false);

  function providerLabel(provider: AgentProvider | undefined): string {
    return provider === "codex" ? m.agent_provider_codex() : m.agent_provider_claude();
  }

  function defaultTip(on: boolean): string {
    return on ? m.newtask_autopilot_repo_default_on() : m.newtask_autopilot_repo_default_off();
  }
</script>

<div class="group">
  <span class="group-label">{m.newtask_group_engine()}</span>
  <div class="engine">
    <div class="field-select">
      <select
        id="nt-agent-provider"
        aria-label={m.newtask_agent_provider_label()}
        value={agentProvider}
        onchange={(e) => onProviderChange(e.currentTarget.value as AgentProvider)}
      >
        {#each AGENT_PROVIDERS as provider (provider)}
          <option
            value={provider}
            disabled={!!providerConstraint && !providerConstraint.providers.includes(provider)}
          >
            {providerLabel(provider)}
          </option>
        {/each}
      </select>
      {#if agentProvider === "codex"}
        <span class="alpha-badge" aria-hidden="true"
          >{m.newtask_agent_provider_codex_alpha_badge()}</span
        >
      {/if}
      <span class="chev" aria-hidden="true">▾</span>
    </div>

    <EngineCapacityLine limits={usageLimits} provider={agentProvider} />

    {#if providerConstraint}
      <div class="provider-constraint-callout" role="status">
        <div class="constraint-head">
          <span>{m.newtask_provider_constraint_title()}</span>
          <span class="constraint-badge">{providerLabel(providerConstraint.providers[0])}</span>
        </div>
        <p>
          {m.newtask_provider_constraint_note({
            command: providerConstraint.label,
            provider: providerLabel(providerConstraint.providers[0]),
          })}
        </p>
        <p>
          {m.newtask_provider_constraint_body({
            provider: providerLabel(providerConstraint.providers[0]),
          })}
        </p>
      </div>
    {/if}

    <div class="field" use:coachTarget={"model-1m-context"}>
      <div class="field-select">
        <select
          id="nt-model"
          aria-label={m.newtask_model_label()}
          value={model}
          onchange={(e) => onModelChange(e.currentTarget.value)}
        >
          <option value="default">{m.newtask_model_default()}</option>
          {#each provModels as mdl (mdl)}
            {#if agentProvider !== "claude" || mdl !== "fable" || fableAvailable}
              <option value={mdl}>{modelOptionLabel(agentProvider, mdl)}</option>
            {/if}
          {/each}
        </select>
        <span class="chev" aria-hidden="true">▾</span>
      </div>
      <ModelGuidance provider={agentProvider} {model} context="task" compact />
      {#if agentProvider === "claude" && !fableAvailable}
        <p class="field-note">{m.newtask_fable_unavailable()}</p>
      {/if}
    </div>

    <div class="pair">
      <div class="field half" use:coachTarget={"effort-control"}>
        <span class="field-label"><GlossaryText text={m.newtask_effort_label_gloss()} /></span>
        <div class="field-select">
          <select
            id="nt-effort"
            aria-label={m.newtask_effort_label()}
            value={effort}
            onchange={(e) => onEffortChange(e.currentTarget.value)}
          >
            <option value="default">{m.effort_default()}</option>
            {#each provEfforts as tier (tier)}
              <option value={tier}>{effortLabel(tier)}</option>
            {/each}
          </select>
          <span class="chev" aria-hidden="true">▾</span>
        </div>
      </div>
      <div class="field half">
        <span class="field-label">{m.newtask_sandbox_label()}</span>
        <div class="field-select">
          <select
            id="nt-sandbox"
            aria-label={m.newtask_sandbox_label()}
            title={m.newtask_sandbox_hint()}
            value={sandboxProfile}
            onchange={(e) => onSandboxChange(e.currentTarget.value as "default" | SandboxProfile)}
          >
            <option value="default">{m.newtask_sandbox_default()}</option>
            <option value="trusted">{m.sandbox_profile_trusted()}</option>
            <option value="standard">{m.sandbox_profile_standard()}</option>
            <option value="autonomous" disabled={modeLocked}
              >{m.sandbox_profile_autonomous()}</option
            >
          </select>
          <span class="chev" aria-hidden="true">▾</span>
        </div>
      </div>
    </div>
    {#if research}
      <p class="field-note">{m.newtask_research_sandbox_note()}</p>
    {/if}

    {#if agentProvider === "codex"}
      <p class="alpha-caution">
        <span class="warn" aria-hidden="true">⚠</span>
        {m.newtask_alpha_caution()}
        <button
          type="button"
          class="alpha-details"
          aria-expanded={alphaExpanded}
          onclick={() => (alphaExpanded = !alphaExpanded)}>{m.newtask_alpha_details()}</button
        >
      </p>
      {#if alphaExpanded}
        <div class="alpha-full" role="status">
          <p>{m.newtask_agent_provider_codex_alpha_note()}</p>
          {#if holdLikely}
            <p>{m.newtask_agent_provider_codex_suggested_for_hold()}</p>
          {/if}
          <p>{m.newtask_agent_provider_codex_note()}</p>
        </div>
      {/if}
    {/if}
  </div>
</div>

<div class="rule"></div>

<div class="group">
  <span class="group-label">{m.newtask_group_guards()}</span>
  {#if modeLocked}
    <span class="sr-only" id="nt-mode-locked-note"
      >{research ? m.newtask_research_locked_aria() : m.newtask_epic_authoring_locked_aria()}</span
    >
  {/if}
  <div class="guards">
    <div use:coachTarget={"plan-gate"}>
      <InstrumentToggle
        checked={planGate}
        labelMarkup={m.newtask_guard_plan_gate()}
        disabled={modeLocked}
        loading={planGateLoading}
        defaultTip={defaultTip(planGateDefault)}
        onchange={onPlanGateChange}
      />
    </div>
    <div use:coachTarget={"task-autopilot"}>
      <InstrumentToggle
        checked={autopilot}
        labelMarkup={m.newtask_guard_autopilot()}
        disabled={modeLocked}
        loading={autopilotLoading}
        defaultTip={defaultTip(autopilotDefault)}
        onchange={onAutopilotChange}
      />
    </div>
  </div>
</div>

<style>
  .group {
    display: flex;
    flex-direction: column;
  }
  .group-label {
    font-size: var(--fs-micro);
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--color-faint);
    padding-bottom: 6px;
  }
  .rule {
    height: 1px;
    background: var(--color-line);
    margin: 14px 0 12px;
  }
  .engine {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .field-label {
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .field-select {
    position: relative;
    display: flex;
    align-items: center;
  }
  .field-select select {
    appearance: none;
    width: 100%;
    box-sizing: border-box;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-ink-bright);
    font: inherit;
    font-size: var(--fs-base);
    padding: 8px 40px 8px 10px;
    cursor: pointer;
  }
  .pair .field-select select {
    font-size: var(--fs-meta);
    padding: 6px 22px 6px 8px;
  }
  .field-select select:focus {
    outline: none;
    border-color: var(--color-line-bright);
  }
  .chev {
    position: absolute;
    right: 8px;
    color: var(--color-muted);
    font-size: var(--fs-micro);
    pointer-events: none;
  }
  .alpha-badge {
    position: absolute;
    right: 22px;
    color: var(--color-amber);
    font-size: var(--fs-micro);
    letter-spacing: 0.06em;
    border: 1px solid color-mix(in srgb, var(--color-amber) 62%, var(--color-line));
    border-radius: 2px;
    padding: 0 4px;
    pointer-events: none;
  }
  .pair {
    display: flex;
    gap: 8px;
  }
  .half {
    flex: 1;
  }
  .field-note {
    margin: 0;
    font-size: var(--fs-micro);
    color: var(--color-muted);
    line-height: 1.4;
  }
  .alpha-caution {
    margin: 0;
    font-size: var(--fs-micro);
    color: var(--color-muted);
    line-height: 1.4;
  }
  .alpha-caution .warn {
    color: var(--color-amber);
  }
  .alpha-details {
    background: transparent;
    border: 0;
    padding: 0;
    font: inherit;
    color: var(--color-blue);
    cursor: pointer;
  }
  .alpha-details:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .alpha-full {
    border: 1px solid color-mix(in srgb, var(--color-amber) 46%, var(--color-line));
    background: color-mix(in srgb, var(--color-amber) 12%, transparent);
    color: var(--color-ink);
    font-size: var(--fs-meta);
    line-height: 1.35;
    padding: 8px 10px;
    border-radius: 2px;
  }
  .alpha-full p {
    margin: 0;
  }
  .alpha-full p + p {
    margin-top: 5px;
  }
  .provider-constraint-callout {
    border: 1px solid color-mix(in srgb, var(--color-blue) 52%, var(--color-line));
    background: color-mix(in srgb, var(--color-blue) 13%, transparent);
    color: var(--color-ink);
    font-size: var(--fs-meta);
    line-height: 1.35;
    padding: 8px 10px;
    border-radius: 2px;
  }
  .provider-constraint-callout p {
    margin: 0;
  }
  .provider-constraint-callout p + p {
    margin-top: 5px;
  }
  .constraint-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 5px;
    color: var(--color-blue);
    font-size: var(--fs-meta);
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  .constraint-badge {
    border: 1px solid color-mix(in srgb, var(--color-blue) 62%, var(--color-line));
    color: var(--color-blue);
    padding: 1px 6px;
    border-radius: 2px;
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
  }
  .guards {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  @media (max-width: 768px) {
    .field-select select {
      min-height: 44px;
      font-size: var(--fs-lg);
    }
    .pair .field-select select {
      min-height: 44px;
    }
  }
</style>
