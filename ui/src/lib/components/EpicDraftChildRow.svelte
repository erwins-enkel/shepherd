<script lang="ts">
  import type { EpicDraftChild } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import MarkdownBody from "$lib/components/MarkdownBody.svelte";

  let {
    child,
    index,
    wave,
    materializedNumber,
    blockers,
    onjump,
  }: {
    child: EpicDraftChild;
    index: number;
    /** 1-based dependency wave (see childWaves): children sharing a wave can run in parallel. */
    wave: number;
    /** The real issue number once materialized, else null (still a draft key). */
    materializedNumber: number | null;
    /** The sibling children this one waits for, pre-labelled "<position> · <title>". */
    blockers: { key: string; label: string }[];
    /** Scroll the review to a sibling child. */
    onjump: (key: string) => void;
  } = $props();
</script>

<li class="edp-row" data-anchor={`child-${child.key}`} data-child-key={child.key}>
  <span class="edp-num" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
  <div class="edp-fields">
    <span class="edp-child-title">
      {#if materializedNumber != null}
        <span class="edp-child-num">#{materializedNumber}</span>
      {/if}
      {child.title}
    </span>
    {#if child.body}<div class="edp-child-body"><MarkdownBody source={child.body} /></div>{/if}
    {#if child.acceptanceCriteria.length}
      <ul class="edp-crit">
        {#each child.acceptanceCriteria as c, i (i)}<li>{c}</li>{/each}
      </ul>
    {/if}
    {#if blockers.length}
      <div class="edp-blocked">
        <span class="edp-blocked-label">{m.epicdraft_blocked_by_label()}</span>
        {#each blockers as b (b.key)}
          <button type="button" class="edp-dep" onclick={() => onjump(b.key)}>{b.label}</button>
        {/each}
      </div>
    {/if}
  </div>
  <span class="edp-wave">{m.epicdraft_wave({ n: wave })}</span>
</li>

<style>
  .edp-row {
    display: grid;
    grid-template-columns: 2.4em minmax(0, 1fr) auto;
    column-gap: 10px;
    align-items: start;
    padding: 12px 0;
    border-top: 1px solid var(--color-line);
    scroll-margin-top: 8px;
  }
  .edp-num {
    color: var(--color-muted);
    font-size: var(--fs-meta);
    line-height: 1.75;
  }
  .edp-fields {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .edp-child-title {
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
    font-weight: 600;
    line-height: 1.45;
  }
  .edp-child-num {
    color: var(--color-accent);
    margin-right: 3px;
  }
  .edp-child-body {
    max-width: 74ch;
    font-size: var(--fs-base);
    line-height: 1.55;
  }
  .edp-crit {
    margin: 0;
    max-width: 74ch;
    padding-left: 18px;
    color: var(--color-muted);
    font-size: var(--fs-base);
    line-height: 1.5;
  }
  .edp-blocked {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-meta);
  }
  .edp-blocked-label {
    color: var(--color-amber);
  }
  .edp-dep {
    max-width: 32ch;
    min-height: 28px;
    padding: 2px 8px;
    overflow: hidden;
    background: var(--color-panel-2);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font: inherit;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
  }
  .edp-dep:hover,
  .edp-dep:focus-visible {
    border-color: var(--color-amber);
    color: var(--color-ink-bright);
  }
  .edp-wave {
    color: var(--color-muted);
    font-size: var(--fs-meta);
    line-height: 1.75;
    white-space: nowrap;
  }
</style>
