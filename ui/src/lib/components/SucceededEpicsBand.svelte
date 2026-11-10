<script lang="ts">
  import type { CompletedEpic } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { succeededEpicsOf } from "#lib/succeeded-epics.js";
  import { succeededEpicsExplanation } from "#lib/tooltips/explanations.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import EpicOutcomeRow from "./EpicOutcomeRow.svelte";

  // #3838: succeeded epics stay in the active view, each with its completion time, until the
  // operator confirms it — whether or not any of its sessions is still around.
  let {
    epics,
    nowMs = Date.now(),
    onacknowledge,
    onackmigrations,
  }: {
    /** The scope's completed epics; the band keeps only the succeeded ones. */
    epics: CompletedEpic[];
    nowMs?: number;
    onacknowledge: (repoPath: string, parent: number) => Promise<boolean>;
    onackmigrations?: (repoPath: string, parent: number) => void | Promise<void>;
  } = $props();
  let closed = $state(false);
  const shown = $derived(succeededEpicsOf(epics));
  const title = $derived(m.succeeded_epics_band_title({ count: shown.length }));
</script>

{#if shown.length > 0}
  <section class="band" aria-label={title}>
    <button
      type="button"
      class="band-head"
      aria-expanded={!closed}
      onclick={() => (closed = !closed)}
    >
      <span class="chev" class:collapsed={closed} aria-hidden="true">▾</span>
      <span class="label">{title}</span>
    </button>
    <div class="band-summary">
      <span>{m.succeeded_epics_band_summary()}</span>
      <button class="help" type="button" use:statusTip={{ text: succeededEpicsExplanation() }}
        >{m.integrated_epics_how()}</button
      >
    </div>
    {#if !closed}
      <div class="rows">
        {#each shown as epic (`${epic.repoPath}#${epic.parentIssueNumber}`)}
          <EpicOutcomeRow {epic} {nowMs} {onacknowledge} {onackmigrations} />
        {/each}
      </div>
    {/if}
  </section>
{/if}

<style>
  .band {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-block: 6px;
    background: var(--color-panel);
    min-width: 0;
  }
  .band-head {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 10px 4px 0;
    border: 0;
    border-top: 1px solid var(--color-line);
    background: none;
    color: var(--color-ink-bright);
    font: inherit;
    font-size: var(--fs-meta);
    text-align: left;
    cursor: pointer;
  }
  .band-head:focus-visible,
  .help:focus-visible {
    outline: 2px solid var(--color-ink-bright);
    outline-offset: 2px;
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
  .band-summary {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 8px;
    padding-inline: 4px;
    font-size: var(--fs-meta);
    line-height: 1.5;
    color: var(--color-muted);
  }
  .help {
    padding: 0;
    border: 0;
    background: none;
    color: var(--color-ink);
    font: inherit;
    text-decoration: underline;
    text-underline-offset: 3px;
    cursor: pointer;
  }
  .help:hover {
    color: var(--color-ink-bright);
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-bottom: 4px;
  }
  @media (pointer: coarse) {
    .band-head,
    .help {
      min-height: 44px;
    }
  }
</style>
