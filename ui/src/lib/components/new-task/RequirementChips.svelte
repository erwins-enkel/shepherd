<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { capabilityLabel } from "#lib/machines.js";
  import { REQUIREMENT_OPTIONS } from "#lib/placement.js";
  import GlossaryText from "#lib/components/GlossaryText.svelte";

  // The task's requirements (#2770) as editable chips in New Task (#2772): what the machine that
  // runs it must have. The automatic choice picks a machine whose report has them all; a machine
  // named under Run on must have them too.
  let {
    requirements,
    onchange,
  }: { requirements: readonly string[]; onchange: (next: string[]) => void } = $props();

  const options = $derived(REQUIREMENT_OPTIONS.filter((id) => !requirements.includes(id)));

  function add(id: string) {
    if (id) onchange([...requirements, id].sort());
  }
</script>

<div class="nt-requirements" role="group" aria-label={m.newtask_requirements_aria()}>
  <span class="label"><GlossaryText text={m.newtask_requirements_label()} /></span>
  {#each requirements as id (id)}
    <span class="chip">
      {capabilityLabel(id)}
      <button
        type="button"
        aria-label={m.newtask_requirements_remove({ capability: capabilityLabel(id) })}
        onclick={() => onchange(requirements.filter((x) => x !== id))}>×</button
      >
    </span>
  {:else}
    <span class="none">{m.newtask_requirements_none()}</span>
  {/each}
  {#if options.length > 0}
    <select
      aria-label={m.newtask_requirements_add()}
      value=""
      onchange={(e) => {
        add(e.currentTarget.value);
        e.currentTarget.value = "";
      }}
    >
      <option value="">{m.newtask_requirements_add()}</option>
      {#each options as id (id)}
        <option value={id}>{capabilityLabel(id)}</option>
      {/each}
    </select>
  {/if}
</div>

<style>
  .nt-requirements {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-micro);
    color: var(--color-muted);
  }
  .none {
    color: var(--color-faint);
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 2px 1px 7px;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
  }
  .chip button {
    background: transparent;
    border: none;
    color: var(--color-muted);
    font: inherit;
    padding: 0 4px;
    cursor: pointer;
  }
  .chip button:hover,
  .chip button:focus-visible {
    color: var(--color-red);
  }
  select {
    background: transparent;
    border: 1px dashed var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-muted);
    font: inherit;
    padding: 1px 4px;
    cursor: pointer;
  }
</style>
