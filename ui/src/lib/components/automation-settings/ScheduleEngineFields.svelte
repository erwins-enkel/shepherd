<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { pickerModels } from "#lib/provider-models.js";
  import { providerEfforts, effortLabel } from "#lib/effort-guidance.js";
  import { providerCapacityRows } from "#lib/components/usage-gauges.js";
  import type { AgentProvider, UsageLimits } from "#lib/types.js";

  let {
    provider,
    defaultProvider,
    limits,
    onproviderchange,
    research = $bindable(false),
    model = $bindable(""),
    effort = $bindable(""),
  }: {
    provider: AgentProvider | "";
    defaultProvider: AgentProvider;
    limits: UsageLimits | null;
    onproviderchange: (provider: AgentProvider | "") => void;
    research?: boolean;
    model?: string;
    effort?: string;
  } = $props();

  const effectiveProvider = $derived(provider || defaultProvider);
  const capacityRows = $derived(providerCapacityRows(limits));
</script>

<div class="engine-fields">
  <fieldset class="field">
    <legend>{m.schedules_mode()}</legend>
    <div class="segment">
      <button type="button" aria-pressed={!research} onclick={() => (research = false)}
        >{m.schedules_mode_code()}</button
      >
      <button type="button" aria-pressed={research} onclick={() => (research = true)}
        >{m.schedules_mode_research()}</button
      >
    </div>
  </fieldset>
  <fieldset class="field">
    <legend>{m.schedules_engine()}</legend>
    <div class="engines">
      {#each capacityRows as row (row.provider)}
        {@const week = row.windows.find((w) => w.key === "WK")}
        {@const fiveh = row.windows.find((w) => w.key === "5H")}
        <button
          type="button"
          class="engine"
          class:stale={row.stale}
          aria-pressed={effectiveProvider === row.provider}
          onclick={() => onproviderchange(row.provider)}
        >
          <span class="engine-name"
            >{row.provider === "claude" ? m.agent_provider_claude() : m.agent_provider_codex()}
            {#if !provider && defaultProvider === row.provider}<span class="badge"
                >{m.schedules_default()}</span
              >{/if}
          </span>
          <span class="usage"
            >{row.available
              ? m.schedules_usage({
                  week: week?.usedPct ?? "—",
                  fiveh: fiveh?.usedPct ?? "—",
                })
              : m.schedules_usage_unknown()}</span
          >
        </button>
      {/each}
    </div>
    <button type="button" class="text-link default-link" onclick={() => onproviderchange("")}
      >{m.schedules_use_default()}</button
    >
  </fieldset>
  <label class="field">
    <span>{m.schedules_field_model()}</span>
    <select bind:value={model}>
      <option value="">{m.schedules_default()}</option>
      {#each pickerModels(effectiveProvider, model) as id (id)}<option value={id}>{id}</option
        >{/each}
    </select>
  </label>
  <label class="field">
    <span>{m.schedules_field_effort()}</span>
    <select bind:value={effort}>
      <option value="">{m.schedules_default()}</option>
      {#each providerEfforts(effectiveProvider, model || null) as id (id)}<option value={id}
          >{effortLabel(id)}</option
        >{/each}
    </select>
  </label>
</div>

<style>
  .engine-fields {
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-width: 0;
    grid-area: engine;
    border-left: 1px solid var(--color-line);
    padding-left: 24px;
  }
  .segment button {
    flex: 1;
    border: 1px solid var(--color-line);
    background: transparent;
    color: var(--color-muted);
    padding: 8px 0;
    cursor: pointer;
  }
  .segment [aria-pressed="true"] {
    color: var(--color-amber);
    border-color: var(--color-amber);
    background: var(--color-sel);
  }
  .segment {
    display: flex;
  }
  .engines {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .engine {
    display: flex;
    flex-direction: column;
    gap: 8px;
    text-align: left;
    border: 1px solid var(--color-line);
    background: transparent;
    color: var(--color-ink);
    padding: 12px;
    cursor: pointer;
  }
  .engine[aria-pressed="true"] {
    border-color: var(--color-amber);
    background: var(--color-sel);
  }
  .engine[aria-pressed="true"] .engine-name::before {
    content: "✓ ";
    color: var(--color-amber);
  }
  .engine-name {
    font-weight: 600;
  }
  .badge {
    margin-left: 6px;
    border: 1px solid var(--color-line-bright);
    color: var(--color-muted);
    padding: 1px 4px;
    font-size: var(--fs-micro);
    font-weight: 400;
  }
  .usage {
    font-family: var(--font-mono);
    color: var(--color-muted);
    font-size: var(--fs-micro);
  }
  .stale .usage {
    opacity: 0.55;
  }
  .default-link {
    align-self: flex-start;
  }
  @media (max-width: 768px) {
    .engine-fields {
      border: 0;
      padding: 0;
    }
  }
</style>
