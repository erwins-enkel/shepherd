<script lang="ts">
  import type { Snippet } from "svelte";
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
    tag,
    quietEmpty = false,
  }: {
    requirements: readonly string[];
    onchange: (next: string[]) => void;
    /** Where the chips came from (#2773), right after them: "from task" or "reading task…". */
    tag?: Snippet;
    /** Leave out "none" while the requirements are still being read. */
    quietEmpty?: boolean;
  } = $props();

  const options = $derived(REQUIREMENT_OPTIONS.filter((id) => !requirements.includes(id)));

  function add(id: string) {
    if (id) onchange([...requirements, id].sort());
  }
</script>

<div class="nt-requirements" role="group" aria-label={m.newtask_requirements_aria()}>
  <span class="label"><GlossaryText text={m.newtask_requirements_heading()} /></span>
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
    {#if !quietEmpty}
      <span class="none">{m.newtask_requirements_none()}</span>
    {/if}
  {/each}
  {@render tag?.()}
  {#if options.length > 0}
    <!-- A compact "+": the native select lies invisibly over it, so its picker, keyboard use and
         touch behavior stay the platform's own. -->
    <span class="add">
      <span aria-hidden="true">+</span>
      <select
        aria-label={m.newtask_requirements_add_aria()}
        value=""
        onchange={(e) => {
          add(e.currentTarget.value);
          e.currentTarget.value = "";
        }}
      >
        <option value="">{m.newtask_requirements_add_aria()}</option>
        {#each options as id (id)}
          <option value={id}>{capabilityLabel(id)}</option>
        {/each}
      </select>
    </span>
  {/if}
</div>

<style>
  .nt-requirements {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  /* The section label of the strip, in the voice of the PROMPT label below it. */
  .label {
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }
  /* The glossary term is a button, and buttons reset text-transform. */
  .label :global(.gloss-term) {
    text-transform: inherit;
  }
  .none {
    color: var(--color-faint);
  }
  .chip,
  .add {
    display: inline-flex;
    align-items: center;
    border-radius: 2px;
    line-height: 1.3;
  }
  .chip {
    padding: 2px 0 2px 8px;
    border: 1px solid var(--color-line-bright);
    background: var(--color-panel-2);
    color: var(--color-ink);
  }
  .chip button {
    position: relative;
    background: transparent;
    border: none;
    color: var(--color-muted);
    font: inherit;
    line-height: 1;
    padding: 0 6px 0 5px;
    cursor: pointer;
  }
  .chip button:hover,
  .chip button:focus-visible {
    color: var(--color-red);
  }
  .add {
    position: relative;
    justify-content: center;
    min-width: 22px;
    padding: 2px 6px;
    border: 1px dashed var(--color-line-bright);
  }
  .add:hover {
    color: var(--color-ink);
    border-color: var(--color-muted);
  }
  .add:has(select:focus-visible) {
    color: var(--color-ink);
    border-style: solid;
    border-color: var(--color-amber);
  }
  .add select {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0;
    border: 0;
    opacity: 0;
    appearance: none;
    font: inherit;
    cursor: pointer;
  }
  /* Touch: thumb-sized controls, and a 44px-tall hit area around "×" and "+". */
  @media (pointer: coarse) {
    .chip,
    .add {
      min-height: 32px;
    }
    .add,
    .chip button {
      min-width: 32px;
    }
    .chip button {
      align-self: stretch;
    }
    /* 26px content box (32px chip, border-box) + 2 × 9px = 44px. */
    .chip button::after {
      content: "";
      position: absolute;
      inset: -9px 0;
    }
    /* 30px padding box + 2 × 7px = 44px. */
    .add select {
      inset: -7px 0;
      height: auto;
    }
  }
</style>
