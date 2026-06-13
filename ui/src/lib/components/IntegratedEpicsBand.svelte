<script lang="ts">
  import type { CompletedEpic } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import IntegratedEpicRow from "./IntegratedEpicRow.svelte";

  let {
    epics,
    ondismiss,
    nowMs = Date.now(),
  }: {
    epics: CompletedEpic[];
    ondismiss: (repoPath: string, parent: number) => void;
    nowMs?: number;
  } = $props();

  let collapsed = $state(true);

  const count = $derived(epics.length);
</script>

{#if epics.length > 0}
  <section class="band" aria-label={m.integrated_epics_band_title({ count })}>
    <button
      type="button"
      class="band-head"
      aria-label={m.integrated_epics_band_title({ count })}
      aria-expanded={!collapsed}
      onclick={() => (collapsed = !collapsed)}
    >
      <span class="chev" class:collapsed aria-hidden="true">▾</span>
      <span class="label">{m.integrated_epics_band_title({ count })}</span>
    </button>

    {#if !collapsed}
      <div class="rows">
        {#each epics as epic (`${epic.repoPath}#${epic.parentIssueNumber}`)}
          <IntegratedEpicRow {epic} {ondismiss} {nowMs} />
        {/each}
      </div>
    {/if}
  </section>
{/if}

<style>
  .band {
    display: flex;
    flex-direction: column;
    background: var(--color-panel);
  }

  /* Slate/quiet section header with a top rule — the done-state look (NOT green). */
  .band-head {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 10px 8px 6px;
    margin-top: 6px;
    border: 0;
    border-top: 1px solid color-mix(in srgb, var(--status-done) 30%, var(--color-line));
    background: none;
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--status-done);
    text-align: left;
    cursor: pointer;
  }
  .band-head:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }

  .chev {
    flex: none;
    transition: transform 0.12s ease;
  }
  .chev.collapsed {
    transform: rotate(-90deg);
  }

  .label {
    flex: 1;
    min-width: 0;
  }

  .rows {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-bottom: 4px;
  }
</style>
