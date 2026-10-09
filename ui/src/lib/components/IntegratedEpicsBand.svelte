<script lang="ts">
  import type { CompletedEpic } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { deriveIntegratedEpicStatus } from "#lib/integrated-epic-status.js";
  import { epicsToLandExplanation } from "#lib/tooltips/explanations.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import IntegratedEpicRow from "./IntegratedEpicRow.svelte";
  let {
    epics,
    ondismiss,
    onackmigrations,
    onland,
    onresolveconflicts = () => {},
    nowMs = Date.now(),
    collapsed = $bindable(null),
  }: {
    epics: CompletedEpic[];
    nowMs?: number;
    collapsed?: boolean | null;
    ondismiss: (repoPath: string, parent: number) => void;
    onackmigrations: (repoPath: string, parent: number) => void;
    onland: (repoPath: string, parent: number) => void;
    onresolveconflicts?: (repoPath: string, parent: number) => void;
  } = $props();
  const waitingCountId = $props.id();
  const ranked = $derived(
    epics
      .map((epic) => ({ epic, status: deriveIntegratedEpicStatus(epic) }))
      .sort((a, b) => a.status.sortOrder - b.status.sortOrder),
  );
  const waiting = $derived(ranked.filter(({ status }) => status.needsOperator).length);
  const closed = $derived(collapsed ?? waiting === 0);
  const count = $derived(epics.length);
</script>

{#if count > 0}
  <section class="band" aria-label={m.integrated_epics_band_title({ count })}>
    <button
      type="button"
      class="band-head"
      aria-label={m.integrated_epics_band_title({ count })}
      aria-expanded={!closed}
      aria-describedby={waiting > 0 ? waitingCountId : undefined}
      onclick={() => (collapsed = !closed)}
    >
      <span class="chev" class:collapsed={closed} aria-hidden="true">▾</span>
      <span class="label">{m.integrated_epics_band_title({ count })}</span>
      {#if waiting > 0}<span class="waiting-count" id={waitingCountId}
          >{m.integrated_epics_waiting_on_you({ count: waiting })}</span
        >{/if}
    </button>
    <div class="band-summary">
      <span>{m.integrated_epics_band_summary()}</span>
      <button class="help" type="button" use:statusTip={{ text: epicsToLandExplanation() }}
        >{m.integrated_epics_how()}</button
      >
    </div>
    {#if !closed}
      <div class="rows">
        {#each ranked as { epic } (`${epic.repoPath}#${epic.parentIssueNumber}`)}
          <IntegratedEpicRow
            {epic}
            {ondismiss}
            {onackmigrations}
            {onland}
            {onresolveconflicts}
            {nowMs}
          />
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
    flex-wrap: wrap;
    width: 100%;
    padding: 10px 4px 0;
    border: 0;
    border-top: 1px solid var(--color-line);
    background: none;
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    color: var(--color-ink-bright);
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
  .waiting-count {
    padding: 3px 6px;
    border-radius: var(--radius-chip);
    background: var(--status-warn);
    color: var(--color-on-action);
    font-size: var(--fs-micro);
    font-weight: 600;
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
