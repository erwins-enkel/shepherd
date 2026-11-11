<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { scheduleBudgetNumber } from "#lib/schedules.svelte.js";
  import type { AgentProvider } from "#lib/types.js";

  let {
    value = $bindable(null),
    provider,
    valid,
  }: {
    value: number | null;
    provider: AgentProvider | "";
    valid: boolean;
  } = $props();
  const uid = $props.id();
  const disabled = $derived(provider === "codex");
  function input(event: Event) {
    const millions = (event.currentTarget as HTMLInputElement).valueAsNumber;
    const tokens = millions * 1_000_000;
    value = Math.abs(tokens - Math.round(tokens)) < 0.000001 ? Math.round(tokens) : tokens;
  }
</script>

<div class="budget-fields">
  <label class="budget-toggle">
    <input
      type="checkbox"
      checked={value !== null}
      {disabled}
      aria-describedby={disabled || provider === "" ? `${uid}-hint` : undefined}
      onchange={(event) => (value = event.currentTarget.checked ? 2_000_000 : null)}
    />
    <span>{m.schedules_budget_toggle()}</span>
  </label>
  {#if disabled}
    <p id={`${uid}-hint`}>{m.schedules_budget_codex()}</p>
  {:else}
    {#if provider === ""}<p id={`${uid}-hint`}>{m.schedules_budget_default()}</p>{/if}
    {#if value !== null}
      <label class="budget-input"
        >{m.schedules_budget_input()}
        <input
          type="number"
          min="0.1"
          max="100"
          step="0.000001"
          required
          value={value / 1_000_000}
          oninput={input}
          aria-invalid={!valid}
          aria-describedby={`${uid}-measure ${uid}-overshoot`}
        />
      </label>
      <div class="presets" role="group" aria-label={m.schedules_budget_toggle()}>
        {#each [500_000, 1_000_000, 2_000_000, 5_000_000] as tokens (tokens)}
          <button type="button" aria-pressed={value === tokens} onclick={() => (value = tokens)}
            >{m.schedules_budget_unit({ n: scheduleBudgetNumber(tokens) })}</button
          >
        {/each}
      </div>
      <p id={`${uid}-measure`}>{m.schedules_budget_measure()}</p>
      <p id={`${uid}-overshoot`}>{m.schedules_budget_overshoot()}</p>
      {#if !valid}<p class="error" role="alert">{m.schedules_budget_invalid()}</p>{/if}
    {/if}
  {/if}
</div>

<style>
  .budget-fields {
    margin-top: 16px;
    border-top: 1px solid var(--color-line);
    padding-top: 12px;
  }
  .budget-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--fs-meta);
  }
  .budget-input {
    display: grid;
    gap: 4px;
    margin-top: 8px;
    font-size: var(--fs-meta);
  }
  .budget-input input {
    width: 100%;
    background: var(--color-bg);
    color: var(--color-ink);
    border: 1px solid var(--color-line);
    padding: 6px 8px;
    font: inherit;
    font-family: var(--font-mono);
  }
  .presets {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 8px;
  }
  button {
    background: transparent;
    border: 1px solid var(--color-line);
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-meta);
    padding: 4px 8px;
    cursor: pointer;
  }
  button:focus-visible,
  input:focus-visible {
    outline: 1px solid var(--color-amber);
    outline-offset: 2px;
  }
  button[aria-pressed="true"] {
    border-color: var(--color-green);
    color: var(--color-green);
  }
  p {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    margin: 6px 0 0;
    line-height: 1.5;
  }
  .error {
    color: var(--color-red);
  }
</style>
