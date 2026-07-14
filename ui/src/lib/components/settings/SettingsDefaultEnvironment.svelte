<script lang="ts">
  import { modelGuidanceAlias, modelOptionLabel } from "$lib/model-guidance";
  import ModelGuidance from "$lib/components/ModelGuidance.svelte";
  import {
    AGENT_PROVIDERS,
    MODELS,
    MODELS_BY_PROVIDER,
    PREMIUM_MODELS,
    type AgentProvider,
  } from "$lib/types";
  import { m } from "$lib/paraglide/messages";

  let {
    defaultAgentProvider = $bindable(),
    defaultModel = $bindable(),
    defaultCodexModel = $bindable(),
    defaultAgentProviderBusy,
    defaultModelBusy,
    defaultCodexModelBusy,
    fableAvailable,
    onProviderChange,
    onClaudeModelChange,
    onCodexModelChange,
  }: {
    defaultAgentProvider: AgentProvider;
    defaultModel: string;
    defaultCodexModel: string;
    defaultAgentProviderBusy: boolean;
    defaultModelBusy: boolean;
    defaultCodexModelBusy: boolean;
    fableAvailable: boolean;
    onProviderChange: () => void | Promise<void>;
    onClaudeModelChange: () => void | Promise<void>;
    onCodexModelChange: () => void | Promise<void>;
  } = $props();

  const isPremiumModel = $derived(PREMIUM_MODELS.includes(defaultModel));
  const is1mModel = $derived(defaultModel.endsWith("[1m]"));
</script>

<div class="rc cli-default">
  <span class="micro">{m.settings_default_environment_title()}</span>
  <p class="hint">{m.settings_default_environment_hint()}</p>
  <div class="cli-row default-env-row">
    <label class="default-env-field">
      <span>{m.settings_default_agent_provider_title()}</span>
      <select
        class="model-select"
        bind:value={defaultAgentProvider}
        disabled={defaultAgentProviderBusy}
        aria-label={m.settings_default_agent_provider_title()}
        onchange={onProviderChange}
      >
        {#each AGENT_PROVIDERS as provider (provider)}
          <option value={provider}>
            {provider === "claude" ? m.agent_provider_claude() : m.agent_provider_codex_alpha()}
          </option>
        {/each}
      </select>
    </label>
    <label class="default-env-field">
      <span>
        {defaultAgentProvider === "claude"
          ? m.settings_default_model_title()
          : m.settings_default_codex_model_title()}
      </span>
      {#if defaultAgentProvider === "claude"}
        <select
          class="model-select"
          data-testid="default-environment-model"
          bind:value={defaultModel}
          disabled={defaultModelBusy}
          aria-label={m.settings_default_model_title()}
          onchange={onClaudeModelChange}
        >
          <option value="auto">{m.settings_default_model_auto()}</option>
          <option value="default">{m.newtask_model_default()}</option>
          {#each MODELS as mdl (mdl)}
            <option value={mdl}>{modelOptionLabel("claude", mdl)}</option>
          {/each}
        </select>
      {:else}
        <select
          class="model-select"
          data-testid="default-environment-model"
          bind:value={defaultCodexModel}
          disabled={defaultCodexModelBusy}
          aria-label={m.settings_default_codex_model_title()}
          onchange={onCodexModelChange}
        >
          <option value="default">{m.newtask_model_default()}</option>
          {#each MODELS_BY_PROVIDER.codex as mdl (mdl)}
            <option value={mdl}>{modelOptionLabel("codex", mdl)}</option>
          {/each}
        </select>
      {/if}
    </label>
  </div>
  <p class="hint">
    {defaultAgentProvider === "claude"
      ? m.settings_default_model_hint()
      : m.settings_default_codex_model_hint()}
  </p>
  <ModelGuidance
    provider={defaultAgentProvider}
    model={defaultAgentProvider === "claude"
      ? modelGuidanceAlias(defaultModel, fableAvailable)
      : defaultCodexModel}
    context="default"
  />
  {#if defaultAgentProvider === "claude" && isPremiumModel}
    <p class="premium-warn">{m.settings_default_model_premium_warning()}</p>
  {/if}
  {#if defaultAgentProvider === "claude" && is1mModel}
    <p class="premium-warn">{m.settings_default_model_1m_note()}</p>
  {/if}
</div>

<style>
  .rc {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .cli-default {
    padding-bottom: 10px;
    border-bottom: 1px solid var(--color-line);
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .hint {
    color: var(--color-faint);
    font-size: var(--fs-meta);
    margin: 0;
  }
  .cli-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .default-env-row {
    align-items: flex-start;
  }
  .default-env-field {
    display: flex;
    flex-direction: column;
    flex: 1 1 12rem;
    min-width: 0;
    gap: 6px;
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }
  .model-select {
    width: 100%;
    min-width: 0;
    align-self: stretch;
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    color: var(--color-ink-bright);
    font: inherit;
    font-size: var(--fs-base);
    padding: 8px 10px;
    border-radius: 2px;
    appearance: none;
    cursor: pointer;
  }
  .model-select:focus {
    outline: none;
    border-color: var(--color-amber);
  }
  .model-select:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .premium-warn {
    color: var(--color-amber);
    font-size: var(--fs-meta);
    margin: 0;
    font-weight: 500;
  }
</style>
