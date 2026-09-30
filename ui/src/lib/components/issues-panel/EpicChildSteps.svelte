<script lang="ts">
  import type { EpicChild } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { chipFor, stateLabel } from "../epic-panel";
  import { childUnlocks } from "../epic-child";

  // "Stand im Epic" steps of a not-started epic child (#2622): Needs first (its blockedBy) →
  // This issue → Unlocks (the siblings that wait on it). Laid out like the epic run area's
  // Now → Next → After cards (EpicRunSteps); a sibling entry selects that child.
  let {
    child,
    siblings,
    titleFor,
    onselectchild = undefined,
  }: {
    child: EpicChild;
    siblings: readonly EpicChild[];
    titleFor: (issue: number) => string | null;
    onselectchild?: (child: number) => void;
  } = $props();

  const needs = $derived(
    child.blockedBy.map((n) => {
      const sib = siblings.find((s) => s.number === n);
      return { number: n, title: sib?.title ?? titleFor(n), sibling: sib ?? null };
    }),
  );
  const unlocks = $derived(childUnlocks(child, siblings));
  const unlockEntries = $derived(siblings.filter((s) => unlocks.unlocks.includes(s.number)));
</script>

{#snippet entry(number: number, title: string | null, sibling: EpicChild | null)}
  {#if sibling && onselectchild}
    <button class="entry" type="button" onclick={() => onselectchild(number)}>
      <span class="num">#{number}</span>
      <span class="item-title">{title ?? ""}</span>
      <span class="chip tone-{chipFor(sibling.state).tone}">{stateLabel(sibling.state)}</span>
    </button>
  {:else}
    <span class="entry">
      <span class="num">#{number}</span>
      <span class="item-title">{title ?? ""}</span>
      {#if sibling}
        <span class="chip tone-{chipFor(sibling.state).tone}">{stateLabel(sibling.state)}</span>
      {/if}
    </span>
  {/if}
{/snippet}

<ol class="steps">
  <li class="step">
    <span class="step-head">{m.childrun_step_needs()}</span>
    {#if needs.length === 0}
      <span class="quiet">{m.childrun_needs_none()}</span>
    {:else}
      {#each needs as n (n.number)}
        {@render entry(n.number, n.title, n.sibling)}
      {/each}
    {/if}
  </li>
  <li class="step step-this">
    <span class="step-head">{m.childrun_step_this()}</span>
    <span class="entry">
      <span class="num">#{child.number}</span>
      <span class="item-title">{child.title}</span>
    </span>
  </li>
  <li class="step">
    <span class="step-head">{m.childrun_step_unlocks()}</span>
    {#if unlockEntries.length === 0}
      <span class="quiet">{m.epic_run_after_none()}</span>
    {:else}
      {#each unlockEntries as s (s.number)}
        {@render entry(s.number, s.title, s)}
      {/each}
      {#if unlocks.parallel >= 2}
        <span class="note">{m.childrun_parallel({ count: unlocks.parallel })}</span>
      {/if}
    {/if}
  </li>
</ol>

<style>
  /* Same card recipe as EpicRunSteps; "this issue" carries the green ready accent. */
  .steps {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .step {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    padding: 6px 8px;
    border: 1px solid var(--color-line);
    border-left-width: 2px;
    border-radius: 2px;
    background: var(--color-panel);
  }
  .step-this {
    border-left-color: var(--color-green);
  }

  .step-head {
    color: var(--color-faint);
    font-size: var(--fs-micro);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .step-this .step-head {
    color: var(--color-green);
  }

  .entry {
    display: flex;
    align-items: baseline;
    gap: 5px;
    min-width: 0;
    padding: 0;
    background: transparent;
    border: 0;
    color: inherit;
    font: inherit;
    text-align: left;
  }
  button.entry {
    cursor: pointer;
  }
  button.entry:hover .item-title,
  button.entry:focus-visible .item-title {
    color: var(--color-amber);
    text-decoration: underline;
  }
  button.entry:focus-visible {
    outline: none;
  }

  .num {
    flex: none;
    color: var(--color-ink-bright);
    font-size: var(--fs-meta);
  }

  .item-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    color: var(--color-ink);
    font-size: var(--fs-meta);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chip {
    flex: none;
    color: var(--color-faint);
    font-size: var(--fs-micro);
  }
  .chip.tone-done {
    color: var(--status-done);
  }
  .chip.tone-running,
  .chip.tone-review {
    color: var(--status-running);
  }
  .chip.tone-ready {
    color: var(--color-green);
  }

  .note,
  .quiet {
    color: var(--color-faint);
    font-size: var(--fs-micro);
  }
  .quiet {
    font-size: var(--fs-meta);
  }

  @media (max-width: 768px), (pointer: coarse) {
    button.entry {
      min-height: 32px;
      align-items: center;
    }
  }
</style>
