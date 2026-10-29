<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import type { FilterChip } from "../issues-panel";

  // The Issues list's active filters as removable chips plus "{shown} of {total}" (#2639): what
  // hides issues is always visible, including the default-on toggles. Renders nothing when no
  // filter is on and nothing is hidden.
  let {
    chips,
    count,
  }: {
    chips: readonly FilterChip[];
    /** Rendered vs fetched top-level issues; null when nothing is hidden. */
    count: { shown: number; total: number } | null;
  } = $props();
</script>

{#if chips.length > 0 || count}
  <div class="active-filters">
    {#each chips as chip (chip.id)}
      <span class="fchip" data-chip={chip.id}
        >{chip.label}<button
          type="button"
          class="fchip-x"
          aria-label={m.issues_filter_chip_remove({ name: chip.label })}
          onclick={chip.clear}>×</button
        ></span
      >
    {/each}
    {#if count}
      <span class="shown-count">{m.issues_shown_of_total(count)}</span>
    {/if}
  </div>
{/if}

<style>
  .active-filters {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    margin-top: 6px;
  }
  .fchip {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 0 0 0 6px;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font-size: var(--fs-micro);
    letter-spacing: 0.04em;
  }
  .fchip-x {
    padding: 0 5px;
    background: transparent;
    border: 0;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    line-height: 1.2;
    cursor: pointer;
  }
  .fchip-x:hover {
    color: var(--color-ink-bright);
  }
  .fchip-x:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-line-bright);
  }
  .shown-count {
    margin-left: auto;
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.06em;
  }

  /* Touch: grow the × hit area to 44px without growing the chip itself. */
  @media (max-width: 768px), (pointer: coarse) {
    .fchip-x {
      position: relative;
    }
    .fchip-x::after {
      content: "";
      position: absolute;
      inset: 50% auto auto 50%;
      width: 44px;
      height: 44px;
      transform: translate(-50%, -50%);
    }
  }
</style>
